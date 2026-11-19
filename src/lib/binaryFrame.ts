const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes a file chunk frame for WebRTC DataChannel:
 * [2B transferIdLen][transferId UTF8][4B fileIndex u32][8B byteOffset u64][payload...]
 */
export function encodeDataChunk(
  transferId: string,
  fileIndex: number,
  byteOffset: number,
  payload: Uint8Array
): Uint8Array {
  const tidBytes = textEncoder.encode(transferId);
  const totalLen = 2 + tidBytes.length + 4 + 8 + payload.byteLength;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);

  view.setUint16(0, tidBytes.length, false);
  buf.set(tidBytes, 2);
  const metaStart = 2 + tidBytes.length;
  view.setUint32(metaStart, fileIndex, false);
  view.setBigUint64(metaStart + 4, BigInt(byteOffset), false);
  buf.set(payload, metaStart + 12);
  return buf;
}

export interface DecodedDataChunk {
  transferId: string;
  fileIndex: number;
  byteOffset: number;
  payload: Uint8Array;
}

export function decodeDataChunk(raw: ArrayBuffer): DecodedDataChunk | null {
  if (raw.byteLength < 15) return null;
  const view = new DataView(raw);
  const tidLen = view.getUint16(0, false);
  if (raw.byteLength < 2 + tidLen + 12) return null;

  const tidBytes = new Uint8Array(raw, 2, tidLen);
  const transferId = textDecoder.decode(tidBytes);
  const metaStart = 2 + tidLen;
  const fileIndex = view.getUint32(metaStart, false);
  const byteOffset = Number(view.getBigUint64(metaStart + 4, false));
  const payload = new Uint8Array(raw, metaStart + 12);

  return { transferId, fileIndex, byteOffset, payload };
}

/**
 * Wraps a data chunk with targetDeviceId prefix for WebSocket relay:
 * [2B targetIdLen][targetId UTF8][chunkFrame...]
 */
export function encodeRelayPacket(targetDeviceId: string, chunkFrame: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(targetDeviceId);
  const out = new Uint8Array(2 + idBytes.length + chunkFrame.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, idBytes.length, false);
  out.set(idBytes, 2);
  out.set(chunkFrame, 2 + idBytes.length);
  return out;
}

/**
 * Decodes an incoming WebSocket relay binary frame sent by server:
 * [2B fromDeviceIdLen][fromDeviceId UTF8][chunkFrame...]
 */
export function decodeRelayPacket(raw: ArrayBuffer): { fromDeviceId: string; chunk: DecodedDataChunk } | null {
  if (raw.byteLength < 18) return null;
  const view = new DataView(raw);
  const fromIdLen = view.getUint16(0, false);
  if (raw.byteLength < 2 + fromIdLen + 14) return null;

  const fromDeviceId = textDecoder.decode(new Uint8Array(raw, 2, fromIdLen));
  const innerBuf = raw.slice(2 + fromIdLen);
  const chunk = decodeDataChunk(innerBuf);
  if (!chunk) return null;

  return { fromDeviceId, chunk };
}
