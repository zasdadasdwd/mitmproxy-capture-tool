const test = require('node:test');
const assert = require('node:assert/strict');
const ProtobufSchema = require('../../../web/protobuf-schema.js');

const schemaText = `syntax = "proto3";
package example;
enum State { UNKNOWN = 0; READY = 1; }
message Child { string display_name = 1; }
message Envelope {
  uint64 big = 1;
  repeated Child children = 2;
  State state = 3;
  bytes blob = 4;
}
`;

function varint(value) {
  let number = BigInt(value);
  const out = [];
  while (number > 0x7fn) {
    out.push(Number(number & 0x7fn) | 0x80);
    number >>= 7n;
  }
  out.push(Number(number));
  return out;
}

test('compiles self-contained schemas and lists fully qualified message types', () => {
  const compiled = ProtobufSchema.compile(schemaText);
  assert.deepEqual(compiled.types, ['example.Child', 'example.Envelope']);
  assert.deepEqual(compiled.messages, compiled.types);
});

test('decodes 64-bit precision, nested repeated messages, enum names, and base64 bytes', () => {
  const child = [0x0a, 3, 0x41, 0x64, 0x61]; // display_name = "Ada"
  const body = [
    0x08, ...varint(9007199254740993n),
    0x12, child.length, ...child,
    0x18, 1,
    0x22, 2, 1, 2,
  ];
  const decoded = ProtobufSchema.decode(ProtobufSchema.compile(schemaText), 'example.Envelope', Uint8Array.from(body));
  assert.equal(decoded.big, '9007199254740993');
  assert.deepEqual(decoded.children, [{ display_name: 'Ada' }]);
  assert.equal(decoded.state, 'READY');
  assert.equal(decoded.blob, 'AQI=');
});

test('rejects invalid schema, missing types, imports, and non-message names', () => {
  assert.throws(() => ProtobufSchema.compile('message {'), /ProtobufSchema:/);
  assert.throws(() => ProtobufSchema.compile('syntax="proto3"; import "missing.proto"; message A {}'), /不支持 import/);
  assert.deepEqual(ProtobufSchema.compile('// import "comment.proto"\nmessage A {}').types, ['A']);
  assert.throws(() => ProtobufSchema.compile('syntax="proto3"; enum Only { ZERO = 0; }'), /没有 message 类型/);
  const compiled = ProtobufSchema.compile(schemaText);
  assert.throws(() => compiled.decode(Uint8Array.of(), 'example.Missing'), /消息类型无效/);
  assert.throws(() => compiled.decode(Uint8Array.of(), 'example.State'), /不是消息类型/);
});

test('rejects wire mismatches, oversized data, excessive fields, and recursive nesting', () => {
  const compiled = ProtobufSchema.compile(schemaText);
  assert.throws(() => compiled.decode(Uint8Array.of(0x0a, 0), 'example.Envelope'), /wire type 不匹配/);
  assert.throws(() => compiled.decode(new Uint8Array(ProtobufSchema.MAX_MESSAGE_BYTES + 1), 'example.Envelope'), /报文超过/);
  const many = [];
  for (let i = 0; i <= ProtobufSchema.MAX_FIELDS; i++) many.push(0x08, 0);
  assert.throws(() => compiled.decode(Uint8Array.from(many), 'example.Envelope'), /字段总数超过/);

  const recursive = ProtobufSchema.compile('syntax="proto3"; message Node { Node next = 1; }');
  let nested = [];
  for (let i = 0; i < ProtobufSchema.MAX_DEPTH + 1; i++) nested = [0x0a, nested.length, ...nested];
  assert.throws(() => recursive.decode(Uint8Array.from(nested), 'Node'), /嵌套深度超过/);
});

test('bounds the number of values inside packed repeated fields', () => {
  const packed = ProtobufSchema.compile('syntax="proto3"; message Packed { repeated uint32 values = 1; }');
  const payload = new Uint8Array(ProtobufSchema.MAX_FIELDS + 1);
  const wire = Uint8Array.from([0x0a, ...varint(payload.length), ...payload]);
  assert.throws(() => packed.decode(wire, 'Packed'), /字段总数超过/);
});

test('preflights scalar and nested-message map entries', () => {
  const maps = ProtobufSchema.compile(`syntax="proto3";
    message Child { string name = 1; }
    message Maps { map<string, Child> children = 1; map<int32, string> labels = 2; }
  `);
  // children["k"].name = "A"; labels[7] = "ok".
  const wire = Uint8Array.from([
    0x0a, 8, 0x0a, 1, 0x6b, 0x12, 3, 0x0a, 1, 0x41,
    0x12, 6, 0x08, 7, 0x12, 2, 0x6f, 0x6b,
  ]);
  const decoded = maps.decode(wire, 'Maps');
  assert.deepEqual(decoded.children, { k: { name: 'A' } });
  assert.deepEqual(decoded.labels, { 7: 'ok' });
});

test('bounds and decodes packed fixed-width repeated values', () => {
  const packed = ProtobufSchema.compile('syntax="proto3"; message Fixed { repeated float floats=1; repeated fixed64 values=2; }');
  const wire = Uint8Array.from([
    0x0a, 4, 0, 0, 0xc0, 0x3f,
    0x12, 8, 1, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const decoded = packed.decode(wire, 'Fixed');
  assert.deepEqual(decoded.floats, [1.5]);
  assert.deepEqual(decoded.values, ['1']);
});

test('rejects schemas over the UTF-8 byte limit', () => {
  assert.throws(() => ProtobufSchema.compile(' '.repeat(ProtobufSchema.MAX_SCHEMA_BYTES + 1)), /schema 超过/);
});
