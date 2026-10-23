//! Vector objects of a CSP vector layer (`VectorObjectList.VectorData`).
//!
//! Vector layers (name frames, lines, balloons) store no pixels; CSP redraws
//! them from this data. Big endian layout:
//!
//! ```text
//! u32 0, u32 length of the rest
//! object × n:
//!   header (header_size bytes): u32 header_size, u32 ?, u32 point_size, u32 ?,
//!     u32 point_count, u32 flags, i32 bbox[4], ..., f64 brush size at
//!     header_size - 12, u32 ?
//!   point × point_count (point_size bytes each): f64 x, f64 y, i32 bbox[4], ...
//! ```
//!
//! Coordinates are layer-local (add `LayerOffsetX/Y` for the canvas).
//! Undecoded fields are copied unchanged by [`transform_vector_data`].

use crate::bytes::{be_f64, be_i32, be_u32};
use crate::error::{CspError, Result};

pub const CLOSED_FLAG: u32 = 0x1000;
const OBJECT_HEADER_SIZE: usize = 40;
const POINT_HEAD_SIZE: usize = 32;
const PAYLOAD_HEAD_SIZE: usize = 8;
const BRUSH_SIZE_FROM_END: usize = 12;

pub type BBox = (i32, i32, i32, i32);

/// One stroke or shape (layer-local coordinates).
#[derive(Debug, Clone, PartialEq)]
pub struct VectorObject {
    pub flags: u32,
    pub bbox: BBox,
    pub points: Vec<(f64, f64)>,
    pub brush_size: f64,
}

impl VectorObject {
    /// Whether the shape is closed (observed for rectangles and balloons).
    pub fn closed(&self) -> bool {
        self.flags & CLOSED_FLAG != 0
    }
}

#[derive(Debug, Clone, Copy)]
struct ObjectSpan {
    start: usize,
    header_size: usize,
    point_size: usize,
    point_count: usize,
}

impl ObjectSpan {
    fn end(&self) -> usize {
        self.start + self.header_size + self.point_size * self.point_count
    }

    fn brush_size_offset(&self) -> usize {
        self.start + self.header_size - BRUSH_SIZE_FROM_END
    }

    fn point_offset(&self, index: usize) -> usize {
        self.start + self.header_size + index * self.point_size
    }
}

fn spans(payload: &[u8]) -> Result<Vec<ObjectSpan>> {
    if payload.len() < PAYLOAD_HEAD_SIZE {
        return Err(CspError::format("VectorData is too short"));
    }
    let end = PAYLOAD_HEAD_SIZE + be_u32(payload, 4)? as usize;
    if end > payload.len() {
        return Err(CspError::format("VectorData length exceeds the payload"));
    }
    let mut result = Vec::new();
    let mut position = PAYLOAD_HEAD_SIZE;
    while position < end {
        if position + OBJECT_HEADER_SIZE > end {
            return Err(CspError::format(format!("Truncated vector object at {position}")));
        }
        let header_size = be_u32(payload, position)? as usize;
        let point_size = be_u32(payload, position + 8)? as usize;
        let point_count = be_u32(payload, position + 16)? as usize;
        if header_size < OBJECT_HEADER_SIZE + BRUSH_SIZE_FROM_END || point_size < POINT_HEAD_SIZE {
            return Err(CspError::format(format!(
                "Unexpected vector object layout at {position}"
            )));
        }
        let span = ObjectSpan {
            start: position,
            header_size,
            point_size,
            point_count,
        };
        position = span.end();
        if position > end {
            return Err(CspError::format("Vector object exceeds VectorData length"));
        }
        result.push(span);
    }
    Ok(result)
}

fn read_bbox(payload: &[u8], offset: usize) -> Result<BBox> {
    Ok((
        be_i32(payload, offset)?,
        be_i32(payload, offset + 4)?,
        be_i32(payload, offset + 8)?,
        be_i32(payload, offset + 12)?,
    ))
}

/// Decode all objects of a `VectorData` payload.
pub fn parse_vector_data(payload: &[u8]) -> Result<Vec<VectorObject>> {
    spans(payload)?
        .into_iter()
        .map(|span| {
            let points = (0..span.point_count)
                .map(|index| {
                    let offset = span.point_offset(index);
                    Ok((be_f64(payload, offset)?, be_f64(payload, offset + 8)?))
                })
                .collect::<Result<_>>()?;
            Ok(VectorObject {
                flags: be_u32(payload, span.start + 20)?,
                bbox: read_bbox(payload, span.start + 24)?,
                points,
                brush_size: be_f64(payload, span.brush_size_offset())?,
            })
        })
        .collect()
}

fn map_bbox(bbox: BBox, scale: f64, dx: f64, dy: f64) -> BBox {
    (
        (bbox.0 as f64 * scale + dx).floor() as i32,
        (bbox.1 as f64 * scale + dy).floor() as i32,
        (bbox.2 as f64 * scale + dx).ceil() as i32,
        (bbox.3 as f64 * scale + dy).ceil() as i32,
    )
}

fn write_bbox(data: &mut [u8], offset: usize, bbox: BBox) {
    for (index, value) in [bbox.0, bbox.1, bbox.2, bbox.3].into_iter().enumerate() {
        data[offset + index * 4..offset + index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
}

/// Copy of `payload` with every coordinate mapped to `p * scale + d`; bounding
/// boxes and the brush size follow, so lines keep their relative width.
pub fn transform_vector_data(payload: &[u8], scale: f64, dx: f64, dy: f64) -> Result<Vec<u8>> {
    if scale <= 0.0 {
        return Err(CspError::format("scale must be positive"));
    }
    let mut data = payload.to_vec();
    for span in spans(payload)? {
        let bbox_offset = span.start + 24;
        write_bbox(
            &mut data,
            bbox_offset,
            map_bbox(read_bbox(payload, bbox_offset)?, scale, dx, dy),
        );
        let size_offset = span.brush_size_offset();
        let size = be_f64(payload, size_offset)? * scale;
        data[size_offset..size_offset + 8].copy_from_slice(&size.to_be_bytes());
        for index in 0..span.point_count {
            let offset = span.point_offset(index);
            let x = be_f64(payload, offset)? * scale + dx;
            let y = be_f64(payload, offset + 8)? * scale + dy;
            data[offset..offset + 8].copy_from_slice(&x.to_be_bytes());
            data[offset + 8..offset + 16].copy_from_slice(&y.to_be_bytes());
            let segment = read_bbox(payload, offset + 16)?;
            write_bbox(&mut data, offset + 16, map_bbox(segment, scale, dx, dy));
        }
    }
    Ok(data)
}

/// Payload keeping only the objects at `indexes` (in their original order).
pub fn select_vector_objects(payload: &[u8], indexes: &[usize]) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    for (index, span) in spans(payload)?.into_iter().enumerate() {
        if indexes.contains(&index) {
            body.extend_from_slice(&payload[span.start..span.end()]);
        }
    }
    let mut result = Vec::with_capacity(body.len() + PAYLOAD_HEAD_SIZE);
    result.extend_from_slice(&0u32.to_be_bytes());
    result.extend_from_slice(&(body.len() as u32).to_be_bytes());
    result.extend_from_slice(&body);
    Ok(result)
}

/// Header and point layout CSP 5 writes for a pen or polyline object
/// (92-byte header, 88-byte points), observed in CSP-made files. Fields this
/// module does not decode keep these values.
const NEW_OBJECT_HEADER: [u8; 92] = hex_bytes(
    "0000005c0000004c00000058000000580000000000000011000000000000000000000000000000000000000000000000\
     00000000a244a2445f1f5f1f54ec54ec3ff0000000000000000000000000000240040000000000000f806b70",
);
const NEW_OBJECT_POINT: [u8; 88] = hex_bytes(
    "000000000000000000000000000000000000000000000000000000000000000000000001\
     3f8000003f80000000000000000000003f8000003f8000003f800000000000000000000000000000\
     000000000f806b7000000000",
);
const OPEN_FLAGS: u32 = 0x11;
/// Closed polylines (CSP's 折れ線 with 線を閉じる) add 0x100.
const CLOSED_FLAGS: u32 = 0x111;
const HEADER_POINT_COUNT: usize = 16;
const HEADER_FLAGS: usize = 20;
const HEADER_BBOX: usize = 24;
/// Main colour, `u32` × 3 (black is all zero).
const HEADER_COLOR: usize = 40;
const HEADER_BRUSH_STYLE: usize = 76;
const POINT_BBOX: usize = 16;
const POINT_HAS_SEGMENT: usize = 32;
/// Width factor of the point (pen pressure), `f32`.
const POINT_WIDTH: usize = 36;

const fn hex_bytes<const N: usize>(text: &str) -> [u8; N] {
    let bytes = text.as_bytes();
    let mut result = [0u8; N];
    let (mut index, mut out) = (0, 0);
    while index < bytes.len() {
        let high = bytes[index];
        if high == b' ' || high == b'\n' || high == b'\\' {
            index += 1;
            continue;
        }
        result[out] = (hex_digit(high) << 4) | hex_digit(bytes[index + 1]);
        out += 1;
        index += 2;
    }
    assert!(out == N, "hex length does not match");
    result
}

const fn hex_digit(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        _ => panic!("not a hex digit"),
    }
}

/// A line to draw as a new vector object, in layer-local pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct NewVectorLine {
    /// `(x, y, width factor)`; the factor (pen pressure) is 0..1.
    pub points: Vec<(f64, f64, f64)>,
    pub closed: bool,
    /// Full line width in pixels.
    pub width_px: f64,
}

/// Brush style id the first object of `payload` uses (vector objects name
/// their brush by `BrushStyle.MainId`), if it has one in the known layout.
pub fn brush_style_of(payload: &[u8]) -> Result<Option<u32>> {
    Ok(match spans(payload)?.first() {
        Some(span) if span.header_size > HEADER_BRUSH_STYLE + 4 => {
            Some(be_u32(payload, span.start + HEADER_BRUSH_STYLE)?)
        }
        _ => None,
    })
}

fn segment_box(a: (f64, f64), b: (f64, f64), radius: f64) -> BBox {
    (
        (a.0.min(b.0) - radius).floor() as i32,
        (a.1.min(b.1) - radius).floor() as i32,
        (a.0.max(b.0) + radius).ceil() as i32,
        (a.1.max(b.1) + radius).ceil() as i32,
    )
}

/// A `VectorData` payload holding `lines` (black, drawn with brush style
/// `brush_style`). Lines with fewer than two points are skipped.
pub fn build_vector_data(lines: &[NewVectorLine], brush_style: u32) -> Vec<u8> {
    let mut body = Vec::new();
    for line in lines.iter().filter(|line| line.points.len() >= 2) {
        let radius = (line.width_px / 2.0).max(0.5);
        let points: Vec<(f64, f64)> = line.points.iter().map(|&(x, y, _)| (x, y)).collect();
        let mut header = NEW_OBJECT_HEADER;
        header[HEADER_POINT_COUNT..HEADER_POINT_COUNT + 4].copy_from_slice(&(points.len() as u32).to_be_bytes());
        let flags = if line.closed { CLOSED_FLAGS } else { OPEN_FLAGS };
        header[HEADER_FLAGS..HEADER_FLAGS + 4].copy_from_slice(&flags.to_be_bytes());
        let bounds = points
            .iter()
            .fold(segment_box(points[0], points[0], radius), |acc, &point| {
                let one = segment_box(point, point, radius);
                (acc.0.min(one.0), acc.1.min(one.1), acc.2.max(one.2), acc.3.max(one.3))
            });
        write_bbox(&mut header, HEADER_BBOX, bounds);
        header[HEADER_COLOR..HEADER_COLOR + 12].fill(0);
        header[HEADER_BRUSH_STYLE..HEADER_BRUSH_STYLE + 4].copy_from_slice(&brush_style.to_be_bytes());
        let size_offset = header.len() - BRUSH_SIZE_FROM_END;
        header[size_offset..size_offset + 8].copy_from_slice(&radius.to_be_bytes());
        body.extend_from_slice(&header);
        for (index, &(x, y, width)) in line.points.iter().enumerate() {
            let next = if index + 1 < points.len() {
                Some(points[index + 1])
            } else if line.closed {
                Some(points[0])
            } else {
                None
            };
            let mut point = NEW_OBJECT_POINT;
            point[0..8].copy_from_slice(&x.to_be_bytes());
            point[8..16].copy_from_slice(&y.to_be_bytes());
            write_bbox(
                &mut point,
                POINT_BBOX,
                segment_box((x, y), next.unwrap_or((x, y)), radius),
            );
            point[POINT_HAS_SEGMENT..POINT_HAS_SEGMENT + 4].copy_from_slice(&(next.is_some() as u32).to_be_bytes());
            let width = width.clamp(0.0, 1.0) as f32;
            point[POINT_WIDTH..POINT_WIDTH + 4].copy_from_slice(&width.to_be_bytes());
            body.extend_from_slice(&point);
        }
    }
    let mut payload = Vec::with_capacity(body.len() + PAYLOAD_HEAD_SIZE);
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&(body.len() as u32).to_be_bytes());
    payload.extend_from_slice(&body);
    payload
}

/// The layout of one コマ枠フォルダー border object, taken from a CSP-made
/// frame folder: its header and first point, whose undecoded fields new
/// borders keep (header 96 bytes and points 88 bytes in CSP 5).
#[derive(Debug, Clone, PartialEq)]
pub struct FrameTemplate {
    header: Vec<u8>,
    point: Vec<u8>,
}

/// Border corners keep the miter length (`f32`) and the outward unit
/// bisector (`f32` × 2) after the point's common fields.
const FRAME_POINT_MITER: usize = 64;
const FRAME_HEADER_MIN: usize = 96;
const FRAME_POINT_MIN: usize = 80;

impl FrameTemplate {
    /// The first border of a frame folder's `VectorData`, if it is in the
    /// known layout.
    pub fn of(payload: &[u8]) -> Result<Option<Self>> {
        let Some(span) = spans(payload)?.into_iter().next() else {
            return Ok(None);
        };
        if span.header_size < FRAME_HEADER_MIN || span.point_size < FRAME_POINT_MIN || span.point_count == 0 {
            return Ok(None);
        }
        Ok(Some(FrameTemplate {
            header: payload[span.start..span.start + span.header_size].to_vec(),
            point: payload[span.point_offset(0)..span.point_offset(0) + span.point_size].to_vec(),
        }))
    }

    /// Brush style id the borders are drawn with.
    pub fn brush_style(&self) -> u32 {
        u32::from_be_bytes(
            self.header[HEADER_BRUSH_STYLE..HEADER_BRUSH_STYLE + 4]
                .try_into()
                .unwrap_or_default(),
        )
    }
}

/// One panel of a コマ枠フォルダー: its outline (layer-local pixels) and the
/// border's full width.
#[derive(Debug, Clone, PartialEq)]
pub struct NewFrame {
    pub points: Vec<(f64, f64)>,
    pub width_px: f64,
}

/// Outward unit bisector and miter length of each corner of `points`.
fn frame_corners(points: &[(f64, f64)], radius: f64) -> Vec<((f64, f64), f64)> {
    let n = points.len();
    let unit = |(x, y): (f64, f64)| {
        let length = x.hypot(y);
        if length > 1e-9 {
            (x / length, y / length)
        } else {
            (0.0, 0.0)
        }
    };
    // Signed area: which side of each edge is inside.
    let area: f64 = (0..n)
        .map(|i| {
            let (a, b) = (points[i], points[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    let side = if area >= 0.0 { 1.0 } else { -1.0 };
    (0..n)
        .map(|i| {
            let (a, b, c) = (points[(i + n - 1) % n], points[i], points[(i + 1) % n]);
            let incoming = unit((b.0 - a.0, b.1 - a.1));
            let outgoing = unit((c.0 - b.0, c.1 - b.1));
            // Outward normals of the two edges (y points down, as in CSP).
            let normal = |(x, y): (f64, f64)| (y * side, -x * side);
            let (n1, n2) = (normal(incoming), normal(outgoing));
            let bisector = unit((n1.0 + n2.0, n1.1 + n2.1));
            let bisector = if bisector == (0.0, 0.0) { n2 } else { bisector };
            // The corner's half angle: miter = r / cos(half the turn).
            let cos = (bisector.0 * n2.0 + bisector.1 * n2.1).max(0.1);
            (bisector, radius / cos)
        })
        .collect()
}

/// A frame folder's `VectorData` holding `frames` as closed borders laid out
/// like `template`, drawn with brush style `brush_style`. Frames with fewer
/// than three points are skipped.
pub fn build_frame_data(frames: &[NewFrame], template: &FrameTemplate, brush_style: u32) -> Vec<u8> {
    let mut body = Vec::new();
    for frame in frames.iter().filter(|frame| frame.points.len() >= 3) {
        let radius = (frame.width_px / 2.0).max(0.5);
        let reach = radius + 2.0;
        let points = &frame.points;
        let mut header = template.header.clone();
        header[HEADER_POINT_COUNT..HEADER_POINT_COUNT + 4].copy_from_slice(&(points.len() as u32).to_be_bytes());
        let bounds = points
            .iter()
            .fold(segment_box(points[0], points[0], reach), |acc, &point| {
                let one = segment_box(point, point, reach);
                (acc.0.min(one.0), acc.1.min(one.1), acc.2.max(one.2), acc.3.max(one.3))
            });
        write_bbox(&mut header, HEADER_BBOX, bounds);
        header[HEADER_BRUSH_STYLE..HEADER_BRUSH_STYLE + 4].copy_from_slice(&brush_style.to_be_bytes());
        let size_offset = header.len() - BRUSH_SIZE_FROM_END;
        header[size_offset..size_offset + 8].copy_from_slice(&radius.to_be_bytes());
        body.extend_from_slice(&header);
        for (index, (&(x, y), (bisector, miter))) in points.iter().zip(frame_corners(points, radius)).enumerate() {
            let next = points[(index + 1) % points.len()];
            let mut point = template.point.clone();
            point[0..8].copy_from_slice(&x.to_be_bytes());
            point[8..16].copy_from_slice(&y.to_be_bytes());
            write_bbox(&mut point, POINT_BBOX, segment_box((x, y), next, reach));
            for (offset, value) in [(0, miter), (4, bisector.0), (8, bisector.1)] {
                let at = FRAME_POINT_MITER + offset;
                point[at..at + 4].copy_from_slice(&(value as f32).to_be_bytes());
            }
            body.extend_from_slice(&point);
        }
    }
    let mut payload = Vec::with_capacity(body.len() + PAYLOAD_HEAD_SIZE);
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&(body.len() as u32).to_be_bytes());
    payload.extend_from_slice(&body);
    payload
}
