const test = require('node:test');
const assert = require('node:assert/strict');
const ProtobufViewer = require('../../../web/protobuf-viewer.js');

const bytes = (...values) => Uint8Array.from(values);
test('解析重复字段并保留出现顺序及 uint64 精度', () => {
  const result = ProtobufViewer.parse(bytes(0x08, 0x96, 0x01, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01));
  assert.deepEqual(result.fields.map(x => x.number), [1, 1]);
  assert.equal(result.fields[0].value, '150');
  assert.equal(result.fields[1].value, '18446744073709551615');
  assert.match(ProtobufViewer.format(result), /无 schema 解码/);
});

test('wire 1 / 2 / 5 保留 hex、无符号值及可读候选，嵌套只作推测', () => {
  // field 1 fixed64; field 2 bytes with a valid one-field nested message; field 3 fixed32.
  const result = ProtobufViewer.parse(bytes(0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x12, 2, 0x08, 0x07, 0x1d, 0x78, 0x56, 0x34, 0x12));
  assert.equal(result.fields[0].hex, '0102030405060708');
  assert.equal(result.fields[0].unsigned, '578437695752307201');
  assert.equal(result.fields[1].hex, '0807');
  assert.deepEqual(result.fields[1].messageCandidate.fields.map(x => x.value), ['7']);
  assert.match(result.fields[1].messageCandidate.note, /推测/);
  assert.equal(result.fields[2].unsigned, '305419896');
});

test('多层 LEN 候选和 group 内 LEN 都使用各自的原始偏移', () => {
  const nested = ProtobufViewer.parse(bytes(
    0x0a, 0x04, 0x12, 0x02, 0x08, 0x09, // field 1 -> field 2 -> field 1 = 9
    0x13, 0x22, 0x02, 0x08, 0x0b, 0x14  // group 2 -> LEN field 4 -> candidate field 1 = 11
  ));
  const deep = nested.fields[0].messageCandidate.fields[0].messageCandidate.fields[0].value;
  assert.equal(deep, '9');
  assert.equal(nested.fields[1].group[0].messageCandidate.fields[0].value, '11');
  assert.equal(JSON.stringify(nested).includes('"_start"'), false);
});

test('length-delimited 展示按字段和全局预算截断并注明状态', () => {
  const payload = new Uint8Array(5000).fill(0x61);
  const wire = Uint8Array.from([0x0a, 0x88, 0x27, ...payload]); // length 5000
  const field = ProtobufViewer.parse(wire).fields[0];
  assert.equal(field.length, 5000);
  assert.equal(field.displayBytes, 4096);
  assert.equal(field.displayTruncated, true);
  assert.equal(field.hex.length, 8192);
  assert.equal(field.utf8.length, 4096);
  assert.equal(field.utf8Truncated, true);
});

test('严格拒绝损坏报文，不返回部分结果', () => {
  for (const input of [
    bytes(0x0a, 0x05, 0x01),       // length beyond input
    bytes(0x00),                   // field number zero
    bytes(0x08, 0x80),             // truncated varint
    bytes(0x08, ...Array(9).fill(0x80), 0x02), // uint64 overflow
    bytes(0x09, 1, 2),            // truncated fixed64
    bytes(0x0b, 0x14),            // mismatched group terminator
  ]) assert.throws(() => ProtobufViewer.parse(input), /Protobuf:/);
});

test('输入、字段数和嵌套深度均有界', () => {
  assert.throws(() => ProtobufViewer.parse(new Uint8Array(ProtobufViewer.MAX_BYTES + 1)), /输入超过/);
  const many = [];
  for (let i = 0; i < ProtobufViewer.MAX_FIELDS + 1; i++) many.push(0x08, 0x00);
  assert.throws(() => ProtobufViewer.parse(Uint8Array.from(many)), /字段总数超过/);
  let nested = bytes(0x08, 0x01);
  for (let i = 0; i < ProtobufViewer.MAX_DEPTH + 1; i++) nested = Uint8Array.from([0x0a, nested.length, ...nested]);
  const bounded = ProtobufViewer.parse(nested);
  assert.equal(bounded.fields.length, 1);
  let candidate = bounded.fields[0].messageCandidate;
  let depth = 1;
  while (candidate && candidate.fields[0] && candidate.fields[0].messageCandidate) {
    candidate = candidate.fields[0].messageCandidate;
    depth++;
  }
  assert.ok(depth <= ProtobufViewer.MAX_DEPTH);
  assert.equal(candidate.fields[0].messageCandidate, null);
});

test('maybe 只匹配明确的 protobuf media type', () => {
  assert.equal(ProtobufViewer.maybe('application/x-protobuf; charset=binary'), true);
  assert.equal(ProtobufViewer.maybe('application/vnd.example.protobuf'), true);
  assert.equal(ProtobufViewer.maybe('application/grpc'), false);
  assert.equal(ProtobufViewer.maybe('application/octet-stream'), false);
});
