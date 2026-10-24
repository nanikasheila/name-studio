//! Request bodies the front end sends as raw bytes.

pub(crate) fn lock_error<T>(_: T) -> String {
    "内部エラー（ロック）".to_owned()
}

/// A request body of `[u32 little-endian JSON length][JSON][binary parts...]`:
/// large images travel as raw bytes, not as JSON number arrays.
pub(crate) fn split_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<(T, &[u8]), String> {
    let length = body
        .get(..4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .ok_or("データが壊れています")?;
    let json = body.get(4..4 + length).ok_or("データが壊れています")?;
    let meta = serde_json::from_slice(json).map_err(|error| error.to_string())?;
    Ok((meta, &body[4 + length..]))
}

pub(crate) fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(_) => Err("データの形式が違います".to_owned()),
    }
}

/// A request whose body is the project as the app wrote it (see [`split_body`]):
/// the text is saved as it is, so it travels as bytes rather than as an
/// argument to parse and write again.
pub(crate) fn project_body<T: serde::de::DeserializeOwned>(
    request: &tauri::ipc::Request<'_>,
) -> Result<(T, String), String> {
    split_project_body(&raw_body(request)?)
}

pub(crate) fn split_project_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<(T, String), String> {
    let (meta, rest) = split_body::<T>(body)?;
    let text = String::from_utf8(rest.to_vec()).map_err(|error| error.to_string())?;
    Ok((meta, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(meta: &[u8], rest: &[u8]) -> Vec<u8> {
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta);
        body.extend_from_slice(rest);
        body
    }

    #[test]
    fn a_body_is_its_json_then_the_bytes_after_it() {
        let body = body(br#"{"a":1}"#, &[0, 255, 7]);
        let (meta, rest) = split_body::<serde_json::Value>(&body).unwrap();
        assert_eq!(meta["a"], 1);
        assert_eq!(rest, [0, 255, 7]);
    }

    #[test]
    fn a_broken_body_is_refused() {
        assert!(split_body::<serde_json::Value>(&[1, 0]).is_err());
        let mut short = body(br#"{"a":1}"#, &[]);
        short.truncate(6);
        assert!(split_body::<serde_json::Value>(&short).is_err());
        assert!(split_body::<serde_json::Value>(&body(b"{not json", &[])).is_err());
        assert!(split_project_body::<serde_json::Value>(&body(b"{}", &[0xff, 0xfe])).is_err());
    }
}
