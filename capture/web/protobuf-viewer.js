/** Bounded, schema-free Protocol Buffers wire decoder for inspection only. */
(function (root) {
  'use strict';

  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_FIELDS = 5000;
  const MAX_DEPTH = 8;
  const MAX_FIELD_NUMBER = 0x1fffffff;
  const MAX_FIELD_DISPLAY_BYTES = 4096;
  // Bound duplicated representations across root and speculative nested parses.
  const MAX_TOTAL_DISPLAY_BYTES = 64 * 1024;

  function fail(message) { throw new Error('Protobuf: ' + message); }
  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail('输入必须是字节数组');
  }
  function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }

  function readVarint(bytes, cursor, end, label) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (cursor >= end) fail(label + '被截断');
      const byte = bytes[cursor++];
      if (i === 9 && byte > 1) fail(label + '超过 uint64');
      value |= BigInt(byte & 0x7f) << BigInt(i * 7);
      if ((byte & 0x80) === 0) return { value, cursor };
    }
    fail(label + '超过 10 字节');
  }

  function parseMessage(bytes, start, end, depth, budget, expectedEndGroup) {
    if (depth > MAX_DEPTH) fail('嵌套深度超过 ' + MAX_DEPTH);
    const fields = [];
    let cursor = start;
    while (cursor < end) {
      const tagRead = readVarint(bytes, cursor, end, '字段标签');
      cursor = tagRead.cursor;
      if (tagRead.value > 0xffffffffn) fail('字段标签溢出');
      const tag = Number(tagRead.value);
      const number = Math.floor(tag / 8);
      const wire = tag & 7;
      if (number < 1 || number > MAX_FIELD_NUMBER) fail('字段号无效');
      if (wire === 4) {
        if (expectedEndGroup === null) fail('消息外出现 end group');
        if (number !== expectedEndGroup) fail('group 字段号不匹配');
        return { fields, cursor, endedGroup: true };
      }
      if (wire === 6 || wire === 7) fail('未知 wire type ' + wire);
      budget.count++;
      if (budget.count > MAX_FIELDS) fail('字段总数超过 ' + MAX_FIELDS);

      const field = { number, wireType: wire };
      if (wire === 0) {
        const result = readVarint(bytes, cursor, end, 'varint 值');
        cursor = result.cursor;
        field.value = result.value.toString(10);
      } else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (end - cursor < size) fail('fixed' + (size * 8) + ' 被截断');
        const slice = bytes.subarray(cursor, cursor + size);
        field.hex = hex(slice);
        let unsigned = 0n;
        for (let i = size - 1; i >= 0; i--) unsigned = (unsigned << 8n) | BigInt(slice[i]);
        field.unsigned = unsigned.toString(10);
        cursor += size;
      } else if (wire === 2) {
        const lengthRead = readVarint(bytes, cursor, end, '长度');
        cursor = lengthRead.cursor;
        if (lengthRead.value > BigInt(Number.MAX_SAFE_INTEGER)) fail('长度超出安全范围');
        const length = Number(lengthRead.value);
        if (length > end - cursor) fail('长度超出剩余报文');
        const payloadStart = cursor;
        const payloadEnd = cursor + length;
        const displayLength = Math.min(length, MAX_FIELD_DISPLAY_BYTES, budget.displayBytes);
        const data = bytes.subarray(payloadStart, payloadStart + displayLength);
        budget.displayBytes -= displayLength;
        field.length = length;
        field.displayBytes = displayLength;
        field.displayTruncated = displayLength < length;
        field.hex = hex(data);
        try { field.utf8 = new TextDecoder('utf-8', { fatal: true }).decode(data); }
        catch (_) { field.utf8 = null; }
        field.utf8Truncated = field.displayTruncated && field.utf8 !== null;
        field.messageCandidate = null;
        field._start = payloadStart;
        field._end = payloadEnd;
        cursor = payloadEnd;
      } else if (wire === 3) {
        const group = parseMessage(bytes, cursor, end, depth + 1, budget, number);
        if (!group.endedGroup) fail('group 缺少 end group');
        field.group = group.fields;
        cursor = group.cursor;
      }
      fields.push(field);
    }
    if (expectedEndGroup !== null) fail('group 缺少 end group');
    return { fields, cursor, endedGroup: false };
  }

  function addMessageCandidates(bytes, fields, depth, budget) {
    if (depth >= MAX_DEPTH) return;
    for (const field of fields) {
      if (field.wireType === 2 && field.length > 0 && budget.count < MAX_FIELDS) {
        // Candidate parsing is explicitly heuristic and shares the global field budget.
        const payloadEnd = field._end;
        const payloadStart = field._start;
        try {
          const candidate = parseMessage(bytes, payloadStart, payloadEnd, depth + 1, budget, null);
          field.messageCandidate = candidate.cursor === payloadEnd && candidate.fields.length
            ? { likely: true, fields: candidate.fields, note: '仅按 wire 格式推测；不证明这是子消息' }
            : null;
          if (field.messageCandidate) addMessageCandidates(bytes, candidate.fields, depth + 1, budget);
        } catch (_) {
          field.messageCandidate = null;
        }
      } else if (field.wireType === 3) addMessageCandidates(bytes, field.group, depth + 1, budget);
    }
  }

  function parse(input) {
    const bytes = asBytes(input);
    if (bytes.byteLength > MAX_BYTES) fail('输入超过 ' + MAX_BYTES + ' 字节');
    const budget = { count: 0, displayBytes: MAX_TOTAL_DISPLAY_BYTES };
    const rootMessage = parseMessage(bytes, 0, bytes.length, 0, budget, null);
    if (rootMessage.cursor !== bytes.length) fail('存在未解析数据');
    addMessageCandidates(bytes, rootMessage.fields, 0, budget);
    clearOffsets(rootMessage.fields);
    return { fields: rootMessage.fields, fieldCount: rootMessage.fields.length,
      note: '无 schema 解码：字段号和 wire type 可见，字段名、声明类型与语义无法由报文保证。' };
  }

  function clearOffsets(fields) {
    for (const field of fields) {
      delete field._start;
      delete field._end;
      if (field.group) clearOffsets(field.group);
      if (field.messageCandidate) clearOffsets(field.messageCandidate.fields);
    }
  }

  function format(result) {
    if (!result || !Array.isArray(result.fields)) fail('结果格式无效');
    return JSON.stringify(result, null, 2);
  }
  function maybe(contentType) {
    if (typeof contentType !== 'string') return false;
    const type = contentType.split(';', 1)[0].trim().toLowerCase();
    return /^application\/(?:x-)?protobuf$/.test(type) ||
      /^application\/vnd\.[a-z0-9.+-]*protobuf(?:\.[a-z0-9.+-]+)?$/.test(type);
  }

  const api = { MAX_BYTES, MAX_FIELDS, MAX_DEPTH, parse, format, maybe };
  root.ProtobufViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
