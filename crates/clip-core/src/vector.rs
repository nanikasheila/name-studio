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
//! New lines and frames are built by csp-format (`vector_build`).

use csp_format::vector::VectorData;
pub use csp_format::vector_build::{FrameTemplate, NewFrame, NewVectorLine, shape_signature};

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

/// Copy of `payload` with every coordinate mapped to `p * scale + d`; bounding
/// boxes, control points and the brush size follow, so lines keep their
/// relative width.
pub fn transform_vector_data(payload: &[u8], scale: f64, dx: f64, dy: f64) -> Result<Vec<u8>> {
    if scale <= 0.0 {
        return Err(CspError::format("scale must be positive"));
    }
    let mut data = VectorData::parse(payload)?;
    for object in &mut data.objects {
        object.transform(scale, dx, dy);
    }
    Ok(data.to_bytes())
}

/// Payload keeping only the objects at `indexes` (in their original order).
pub fn select_vector_objects(payload: &[u8], indexes: &[usize]) -> Result<Vec<u8>> {
    let mut data = VectorData::parse(payload)?;
    let mut index = 0;
    data.objects.retain(|_| {
        index += 1;
        indexes.contains(&(index - 1))
    });
    Ok(data.to_bytes())
}

/// Brush style id the first object of `payload` uses (vector objects name
/// their brush by `BrushStyle.MainId`), if it has one in the known layout.
pub fn brush_style_of(payload: &[u8]) -> Result<Option<u32>> {
    Ok(VectorData::parse(payload)?.brush_style())
}

/// The layout of a frame folder's borders, from its `VectorData`.
pub fn frame_template_of(payload: &[u8]) -> Option<FrameTemplate> {
    FrameTemplate::of(&VectorData::parse(payload).ok()?)
}
