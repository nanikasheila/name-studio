//! A layered Photoshop file (PSD) of a page, for painting tools other than
//! CSP (Photoshop, Krita, GIMP, MediBang, FireAlpaca, ibisPaint, Procreate…).
//!
//! The app draws each layer (ラフ線, コマ枠, フキダシ, セリフ…, as the CSP export
//! makes them) as an RGBA image of the whole page; here each is cut to what
//! is drawn on it, packed (PackBits, which every reader takes) and written
//! bottom first, with its name (also in Unicode, `luni`), opacity and
//! whether it is shown. The merged image, which readers that ignore layers
//! show (and thumbnails), is the shown layers over white.
//!
//! Layers are added one at a time and only their packed bytes are kept, so
//! a page of many layers needs one page of memory for the merged image and
//! one for the layer being added.

/// PSD (version 1) takes at most this many pixels on a side.
pub const PSD_MAX_SIDE: u32 = 30000;

/// A layer as drawn: straight (not premultiplied) RGBA, `width * height * 4` bytes, at the page's top left.
pub struct PsdLayer<'a> {
    pub name: &'a str,
    /// The name for readers that know no Unicode names (Shift_JIS on a Japanese PC); none: the ASCII of `name`.
    pub legacy_name: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
    /// 0–255.
    pub opacity: u8,
    pub hidden: bool,
}

struct Record {
    name: String,
    legacy_name: Vec<u8>,
    /// top, left, bottom, right.
    bounds: [i32; 4],
    opacity: u8,
    hidden: bool,
    /// Alpha, red, green, blue: compression and packed rows each.
    channels: [Vec<u8>; 4],
}

/// A PSD being made: its size, its resolution, the layers added so far and the merged image.
pub struct PsdBuilder {
    width: u32,
    height: u32,
    dpi: f64,
    layers: Vec<Record>,
    /// RGB, over white.
    merged: Vec<u8>,
}

/// PackBits: runs of 2–128 of one byte as (1 − n, byte), the rest as (n − 1, bytes…).
fn pack_bits(row: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < row.len() {
        let mut run = 1;
        while i + run < row.len() && run < 128 && row[i + run] == row[i] {
            run += 1;
        }
        if run >= 2 {
            out.push((1i16 - run as i16) as i8 as u8);
            out.push(row[i]);
            i += run;
            continue;
        }
        // Literal bytes up to the next run of 2 or more (a lone pair inside literals costs nothing more to keep).
        let start = i;
        while i < row.len() && i - start < 128 {
            if i + 2 < row.len() && row[i] == row[i + 1] && row[i] == row[i + 2] {
                break;
            }
            i += 1;
        }
        out.push((i - start - 1) as u8);
        out.extend_from_slice(&row[start..i]);
    }
}

/// One channel's rows packed: the compression (1 = PackBits), each row's byte count, then the rows.
fn packed_channel(width: usize, height: usize, sample: impl Fn(usize, usize) -> u8) -> Vec<u8> {
    let mut counts = Vec::with_capacity(height * 2);
    let mut data = Vec::new();
    let mut row = vec![0u8; width];
    for y in 0..height {
        for (x, value) in row.iter_mut().enumerate() {
            *value = sample(x, y);
        }
        let before = data.len();
        pack_bits(&row, &mut data);
        counts.extend_from_slice(&((data.len() - before) as u16).to_be_bytes());
    }
    let mut out = Vec::with_capacity(2 + counts.len() + data.len());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&counts);
    out.extend_from_slice(&data);
    out
}

/// The box (x0, y0, x1, y1) of the pixels that are not fully transparent.
fn drawn_box(width: usize, height: usize, rgba: &[u8]) -> Option<(usize, usize, usize, usize)> {
    let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0, 0);
    for y in 0..height {
        let row = &rgba[y * width * 4..(y + 1) * width * 4];
        let Some(first) = row.as_chunks::<4>().0.iter().position(|pixel| pixel[3] != 0) else {
            continue;
        };
        let last = row
            .as_chunks::<4>()
            .0
            .iter()
            .rposition(|pixel| pixel[3] != 0)
            .unwrap_or(first);
        x0 = x0.min(first);
        x1 = x1.max(last + 1);
        y0 = y0.min(y);
        y1 = y + 1;
    }
    (x1 > x0).then_some((x0, y0, x1, y1))
}

/// The name for tools that read only the old (Pascal) name: its ASCII, or
/// "Layer N" (N from 1, bottom up) so that the layers still differ.
fn ascii_name(name: &str, number: usize) -> Vec<u8> {
    let ascii: Vec<u8> = name
        .bytes()
        .filter(|byte| byte.is_ascii_graphic() || *byte == b' ')
        .collect();
    if ascii.is_empty() {
        format!("Layer {number}").into_bytes()
    } else {
        ascii
    }
}

impl PsdBuilder {
    pub fn new(width: u32, height: u32, dpi: f64) -> Result<Self, String> {
        if width == 0 || height == 0 || width > PSD_MAX_SIDE || height > PSD_MAX_SIDE {
            return Err(format!(
                "PSD にできない大きさです（{width}×{height} px。1 辺 {PSD_MAX_SIDE} px まで）"
            ));
        }
        Ok(Self {
            width,
            height,
            dpi,
            layers: Vec::new(),
            merged: vec![255; width as usize * height as usize * 3],
        })
    }

    /// Adds `layer` on top of those added before (a shown one is also merged).
    pub fn add(&mut self, layer: PsdLayer<'_>) -> Result<(), String> {
        let (width, height) = (layer.width as usize, layer.height as usize);
        if layer.rgba.len() != width * height * 4 {
            return Err(format!("レイヤー「{}」の画素の数が合いません", layer.name));
        }
        let (page_w, page_h) = (self.width as usize, self.height as usize);
        // What lies off the page is cut (the page is the layer's whole world).
        let shown = drawn_box(width, height, layer.rgba)
            .map(|(x0, y0, x1, y1)| (x0, y0, x1.min(page_w), y1.min(page_h)))
            .filter(|(x0, y0, x1, y1)| x1 > x0 && y1 > y0);
        let channels = match shown {
            None => std::array::from_fn(|_| 0u16.to_be_bytes().to_vec()),
            Some((x0, y0, x1, y1)) => {
                let at = |x: usize, y: usize, c: usize| layer.rgba[((y0 + y) * width + x0 + x) * 4 + c];
                let (w, h) = (x1 - x0, y1 - y0);
                [3, 0, 1, 2].map(|c| packed_channel(w, h, |x, y| at(x, y, c)))
            }
        };
        if !layer.hidden
            && let Some((x0, y0, x1, y1)) = shown
        {
            let opacity = layer.opacity as u32;
            for y in y0..y1 {
                for x in x0..x1 {
                    let source = &layer.rgba[(y * width + x) * 4..(y * width + x) * 4 + 4];
                    let alpha = source[3] as u32 * opacity;
                    if alpha == 0 {
                        continue;
                    }
                    let target = &mut self.merged[(y * page_w + x) * 3..(y * page_w + x) * 3 + 3];
                    for c in 0..3 {
                        let (s, t) = (source[c] as u32, target[c] as u32);
                        target[c] = ((s * alpha + t * (255 * 255 - alpha) + 255 * 255 / 2) / (255 * 255)) as u8;
                    }
                }
            }
        }
        let bounds = shown.map_or([0; 4], |(x0, y0, x1, y1)| [y0 as i32, x0 as i32, y1 as i32, x1 as i32]);
        let number = self.layers.len() + 1;
        self.layers.push(Record {
            name: layer.name.to_owned(),
            legacy_name: layer.legacy_name.unwrap_or_else(|| ascii_name(layer.name, number)),
            bounds,
            opacity: layer.opacity,
            hidden: layer.hidden,
            channels,
        });
        Ok(())
    }

    /// The file.
    pub fn finish(self) -> Vec<u8> {
        let mut out = Vec::new();
        // Header: signature, version 1, reserved, 3 channels (RGB), size, 8 bits, RGB.
        out.extend_from_slice(b"8BPS");
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&[0; 6]);
        out.extend_from_slice(&3u16.to_be_bytes());
        out.extend_from_slice(&self.height.to_be_bytes());
        out.extend_from_slice(&self.width.to_be_bytes());
        out.extend_from_slice(&8u16.to_be_bytes());
        out.extend_from_slice(&3u16.to_be_bytes());
        // Color mode data: none for RGB.
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&self.resources());
        let layers = self.layer_section();
        out.extend_from_slice(&(layers.len() as u32).to_be_bytes());
        out.extend_from_slice(&layers);
        // The merged image: planar R, G, B, packed.
        let (w, h) = (self.width as usize, self.height as usize);
        let merged = &self.merged;
        let channels: Vec<Vec<u8>> = (0..3)
            .map(|c| packed_channel(w, h, |x, y| merged[(y * w + x) * 3 + c]))
            .collect();
        // One compression for the whole image, then all row counts (channel by channel), then all rows.
        out.extend_from_slice(&1u16.to_be_bytes());
        let rows = 2 * h;
        for channel in &channels {
            out.extend_from_slice(&channel[2..2 + rows]);
        }
        for channel in &channels {
            out.extend_from_slice(&channel[2 + rows..]);
        }
        out
    }

    /// Image resources: the resolution (so that the page comes in at its print size) and the version info.
    fn resources(&self) -> Vec<u8> {
        let mut section = Vec::new();
        let mut resource = |id: u16, data: &[u8]| {
            section.extend_from_slice(b"8BIM");
            section.extend_from_slice(&id.to_be_bytes());
            section.extend_from_slice(&[0, 0]); // empty name, padded to even
            section.extend_from_slice(&(data.len() as u32).to_be_bytes());
            section.extend_from_slice(data);
            if !data.len().is_multiple_of(2) {
                section.push(0);
            }
        };
        // ResolutionInfo: dpi as 16.16 fixed, in pixels per inch, sizes shown in cm.
        let fixed = ((self.dpi * 65536.0).round() as u32).to_be_bytes();
        let mut resolution = Vec::new();
        for _ in 0..2 {
            resolution.extend_from_slice(&fixed);
            resolution.extend_from_slice(&1u16.to_be_bytes());
            resolution.extend_from_slice(&2u16.to_be_bytes());
        }
        resource(0x03ED, &resolution);
        // VersionInfo: the merged image is real (readers may show it as is).
        let mut version = Vec::new();
        version.extend_from_slice(&1u32.to_be_bytes());
        version.push(1);
        for text in ["Name Studio", "Name Studio"] {
            let units: Vec<u16> = text.encode_utf16().collect();
            version.extend_from_slice(&(units.len() as u32).to_be_bytes());
            for unit in units {
                version.extend_from_slice(&unit.to_be_bytes());
            }
        }
        version.extend_from_slice(&1u32.to_be_bytes());
        resource(0x0421, &version);
        let mut out = (section.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&section);
        out
    }

    /// Layer and mask information: the layer records, their channels, no global mask.
    fn layer_section(&self) -> Vec<u8> {
        let mut info = Vec::new();
        info.extend_from_slice(&(self.layers.len() as i16).to_be_bytes());
        for layer in &self.layers {
            for value in layer.bounds {
                info.extend_from_slice(&value.to_be_bytes());
            }
            info.extend_from_slice(&4u16.to_be_bytes());
            for (id, channel) in [-1i16, 0, 1, 2].into_iter().zip(&layer.channels) {
                info.extend_from_slice(&id.to_be_bytes());
                info.extend_from_slice(&(channel.len() as u32).to_be_bytes());
            }
            info.extend_from_slice(b"8BIMnorm");
            info.push(layer.opacity);
            info.push(0); // clipping: base
            // Flags: bit 1 = hidden, bit 3 + 4 = bit 4 is meaningful (pixel data relevant to appearance).
            info.push(if layer.hidden { 0b0000_1010 } else { 0b0000_1000 });
            info.push(0);
            let mut extra = Vec::new();
            extra.extend_from_slice(&0u32.to_be_bytes()); // no layer mask
            extra.extend_from_slice(&0u32.to_be_bytes()); // no blending ranges
            // The name as a Pascal string padded to a multiple of 4 (length byte included).
            let legacy = &layer.legacy_name[..layer.legacy_name.len().min(255)];
            extra.push(legacy.len() as u8);
            extra.extend_from_slice(legacy);
            while !extra.len().is_multiple_of(4) {
                extra.push(0);
            }
            // luni: the name in UTF-16.
            let units: Vec<u16> = layer.name.encode_utf16().collect();
            let mut unicode = (units.len() as u32).to_be_bytes().to_vec();
            for unit in units {
                unicode.extend_from_slice(&unit.to_be_bytes());
            }
            while !unicode.len().is_multiple_of(4) {
                unicode.push(0);
            }
            extra.extend_from_slice(b"8BIMluni");
            extra.extend_from_slice(&(unicode.len() as u32).to_be_bytes());
            extra.extend_from_slice(&unicode);
            info.extend_from_slice(&(extra.len() as u32).to_be_bytes());
            info.extend_from_slice(&extra);
        }
        for layer in &self.layers {
            for channel in &layer.channels {
                info.extend_from_slice(channel);
            }
        }
        if !info.len().is_multiple_of(2) {
            info.push(0);
        }
        let mut out = (info.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&info);
        out.extend_from_slice(&0u32.to_be_bytes()); // global layer mask: none
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpack(mut data: &[u8], length: usize) -> Vec<u8> {
        let mut out = Vec::new();
        while out.len() < length {
            let n = data[0] as i8;
            if n >= 0 {
                out.extend_from_slice(&data[1..2 + n as usize]);
                data = &data[2 + n as usize..];
            } else if n != -128 {
                out.extend(std::iter::repeat_n(data[1], (1 - n as i16) as usize));
                data = &data[2..];
            } else {
                data = &data[1..];
            }
        }
        assert!(data.is_empty(), "bytes left over");
        out
    }

    #[test]
    fn pack_bits_round_trips() {
        let rows: Vec<Vec<u8>> = vec![
            vec![],
            vec![7],
            vec![1, 2],
            vec![5; 300],
            (0..=255).collect(),
            vec![1, 1, 2, 3, 3, 3, 4, 5, 5, 6, 6, 6, 6, 0, 0],
            (0..1000).map(|i| ((i / 3) % 7) as u8).collect(),
        ];
        for row in rows {
            let mut packed = Vec::new();
            pack_bits(&row, &mut packed);
            assert_eq!(unpack(&packed, row.len()), row);
        }
    }

    fn read_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn writes_layers_cut_to_what_is_drawn_and_merges_the_shown_ones() {
        let (w, h) = (40u32, 30u32);
        let mut builder = PsdBuilder::new(w, h, 350.0).unwrap();
        let mut red = vec![0u8; (w * h * 4) as usize];
        for y in 5..10 {
            for x in 20..30 {
                red[((y * w + x) * 4) as usize..][..4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        builder
            .add(PsdLayer {
                name: "ラフ線",
                legacy_name: None,
                width: w,
                height: h,
                rgba: &red,
                opacity: 255,
                hidden: false,
            })
            .unwrap();
        builder
            .add(PsdLayer {
                name: "メモ（ネーム）",
                legacy_name: None,
                width: w,
                height: h,
                rgba: &vec![0; (w * h * 4) as usize],
                opacity: 128,
                hidden: true,
            })
            .unwrap();
        let merged_red = builder.merged[((7 * w + 25) * 3) as usize..][..3].to_vec();
        assert_eq!(merged_red, [255, 0, 0]);
        assert_eq!(&builder.merged[..3], &[255, 255, 255]);
        let records: Vec<[i32; 4]> = builder.layers.iter().map(|layer| layer.bounds).collect();
        assert_eq!(records, [[5, 20, 10, 30], [0, 0, 0, 0]]);
        // Names with no ASCII still differ in the old name.
        let legacy: Vec<&[u8]> = builder
            .layers
            .iter()
            .map(|layer| layer.legacy_name.as_slice())
            .collect();
        assert_eq!(legacy, [&b"Layer 1"[..], &b"Layer 2"[..]]);
        let file = builder.finish();
        assert_eq!(&file[..4], b"8BPS");
        assert_eq!(read_u32(&file, 14), h);
        assert_eq!(read_u32(&file, 18), w);
        assert!(file.windows(8).any(|window| window == b"8BIMluni"));
    }

    #[test]
    fn refuses_what_psd_cannot_hold() {
        assert!(PsdBuilder::new(PSD_MAX_SIDE + 1, 10, 72.0).is_err());
        let mut builder = PsdBuilder::new(4, 4, 72.0).unwrap();
        let short = PsdLayer {
            name: "x",
            legacy_name: None,
            width: 4,
            height: 4,
            rgba: &[0; 10],
            opacity: 255,
            hidden: false,
        };
        assert!(builder.add(short).is_err());
    }
}
