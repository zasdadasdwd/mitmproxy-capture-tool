/** Compile local .proto text and decode one bounded message without loading imports. */
(function (global) {
  'use strict';

  const MAX_SCHEMA_BYTES = 256 * 1024;
  const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
  const MAX_FIELDS = 10000;
  const MAX_DEPTH = 32;
  const compiledRoots = new WeakMap();

  function fail(message) { throw new Error('ProtobufSchema: ' + message); }

  function runtime() {
    let protobuf = global.protobuf;
    if (typeof module !== 'undefined' && module.exports) {
      if (!protobuf) protobuf = require('./vendor/protobufjs/protobuf.min.js');
      const Long = require('./vendor/protobufjs/long.js');
      protobuf.util.Long = Long;
      protobuf.configure();
    }
    if (protobuf && global.Long && protobuf.util.Long !== global.Long) {
      protobuf.util.Long = global.Long;
      protobuf.configure();
    }
    if (!protobuf || !protobuf.parse || !protobuf.Reader) fail('protobuf.js runtime 未加载');
    if (!protobuf.util.Long) fail('Long runtime 未加载，请先加载 vendor/protobufjs/long.js');
    return protobuf;
  }

  // Scan identifiers while skipping comments and quoted strings. Imports are rejected
  // before protobuf.js can invoke any resolver or attempt to load a second file.
  function hasImport(source) {
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      } else if (c === '/' && source[i + 1] === '*') {
        i += 2;
        const end = source.indexOf('*/', i);
        if (end < 0) return false; // The parser will report the unterminated comment.
        i = end + 2;
      } else if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') i += 2;
          else if (source[i++] === quote) break;
        }
      } else if (/[A-Za-z_]/.test(c)) {
        const start = i++;
        while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
        if (source.slice(start, i) === 'import') return true;
      } else i++;
    }
    return false;
  }

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail('报文必须是字节数组');
  }

  // Walk known nested message fields before decode. This bounds recursive schemas and
  // the total work even when the input is a deeply nested but otherwise valid message.
  function preflight(protobuf, type, reader, budget, depth) {
    if (depth > MAX_DEPTH) fail('消息嵌套深度超过 ' + MAX_DEPTH);
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const id = tag >>> 3;
      const wire = tag & 7;
      if (!id || wire > 5) fail('字段标签或 wire type 无效');
      if (wire === 3 || wire === 4) fail('不支持旧式 group wire type');
      if (++budget.fields > MAX_FIELDS) fail('字段总数超过 ' + MAX_FIELDS);
      const field = type.fieldsById[id];
      if (field && !wireMatches(protobuf, field, wire)) fail('字段 ' + field.name + ' 的 wire type 不匹配');
      if (field && field.map && wire === 2) {
        preflightMapEntry(protobuf, field, reader, budget, depth);
        continue;
      }
      const scalarWire = field ? expectedWire(protobuf, field) : -1;
      if (field && field.repeated && !field.map && scalarWire !== 2 && wire === 2) {
        countPacked(reader, scalarWire, budget);
        continue;
      }
      if (field && field.resolvedType instanceof protobuf.Type && wire === 2) {
        const length = reader.uint32();
        const end = reader.pos + length;
        if (end > reader.len) fail('嵌套消息长度超出报文');
        const previousEnd = reader.len;
        reader.len = end;
        preflight(protobuf, field.resolvedType, reader, budget, depth + 1);
        if (reader.pos !== end) fail('嵌套消息边界无效');
        reader.len = previousEnd;
      } else {
        reader.skipType(wire);
      }
    }
  }

  function preflightMapEntry(protobuf, mapField, reader, budget, depth) {
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) fail('map entry 长度超出报文');
    const previousEnd = reader.len;
    reader.len = end;
    while (reader.pos < end) {
      const tag = reader.uint32();
      const id = tag >>> 3;
      const wire = tag & 7;
      if (!id || wire > 5) fail('map entry 字段标签无效');
      if (wire === 3 || wire === 4) fail('不支持旧式 group wire type');
      if (++budget.fields > MAX_FIELDS) fail('字段总数超过 ' + MAX_FIELDS);
      const valueField = id === 2;
      const known = id === 1 || valueField;
      const valueType = valueField ? mapField.type : mapField.keyType;
      const valueResolved = valueField ? mapField.resolvedType : null;
      const expected = valueResolved instanceof protobuf.Type ? 2 : scalarWireFor(valueType);
      if (known && wire !== expected) fail('map entry 的 key/value wire type 不匹配');
      if (valueField && valueResolved instanceof protobuf.Type && wire === 2) {
        const nestedLength = reader.uint32();
        const nestedEnd = reader.pos + nestedLength;
        if (nestedEnd > reader.len) fail('map value 消息长度超出报文');
        const mapEnd = reader.len;
        reader.len = nestedEnd;
        preflight(protobuf, valueResolved, reader, budget, depth + 2);
        if (reader.pos !== nestedEnd) fail('map value 消息边界无效');
        reader.len = mapEnd;
      } else {
        reader.skipType(wire);
      }
    }
    if (reader.pos !== end) fail('map entry 边界无效');
    reader.len = previousEnd;
  }

  function expectedWire(protobuf, field) {
    if (field.type === 'group') return 3;
    if (field.resolvedType instanceof protobuf.Type) return 2;
    if (field.map) return 2;
    return scalarWireFor(field.type);
  }

  function scalarWireFor(typeName) {
    return ({
      double: 1, fixed64: 1, sfixed64: 1,
      string: 2, bytes: 2,
      float: 5, fixed32: 5, sfixed32: 5,
    })[typeName] ?? 0;
  }

  function countPacked(reader, scalarWire, budget) {
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) fail('packed 字段长度超出报文');
    if (scalarWire === 1 || scalarWire === 5) {
      const width = scalarWire === 1 ? 8 : 4;
      if (length % width) fail('packed fixed 字段长度无效');
      const count = length / width;
      budget.fields += count;
      if (budget.fields > MAX_FIELDS) fail('字段总数超过 ' + MAX_FIELDS);
      reader.pos = end;
      return;
    }
    if (scalarWire !== 0) fail('packed 字段类型无效');
    const previousEnd = reader.len;
    reader.len = end;
    while (reader.pos < end) {
      reader.skipType(0);
      if (++budget.fields > MAX_FIELDS) fail('字段总数超过 ' + MAX_FIELDS);
    }
    if (reader.pos !== end) fail('packed 字段边界无效');
    reader.len = previousEnd;
  }

  function wireMatches(protobuf, field, wire) {
    if (field.type === 'group') return false;
    if (field.map) return wire === 2;
    if (field.resolvedType instanceof protobuf.Type) return wire === 2;
    const expected = expectedWire(protobuf, field);
    if (wire === expected) return true;
    return wire === 2 && field.repeated && expected !== 2;
  }

  function decodeCompiled(compiled, bytes, messageType) {
    const protobuf = runtime();
    if (bytes.byteLength > MAX_MESSAGE_BYTES) fail('报文超过 ' + MAX_MESSAGE_BYTES + ' 字节');
    if (typeof messageType !== 'string' || !messageType.trim()) fail('必须选择消息类型');
    const root = compiledRoots.get(compiled);
    if (!root) fail('schema 尚未编译');
    let object;
    try { object = root.lookup(messageType); }
    catch (error) { fail('消息类型无效：' + messageType); }
    if (!object) fail('消息类型无效：' + messageType);
    if (!(object instanceof protobuf.Type)) fail('所选名称不是消息类型');
    const type = object;
    const reader = protobuf.Reader.create(bytes);
    preflight(protobuf, type, reader, { fields: 0 }, 0);
    const decoded = type.decode(bytes);
    return type.toObject(decoded, { longs: String, bytes: String, enums: String, json: true });
  }

  function compile(schemaText) {
    if (typeof schemaText !== 'string') fail('schema 必须是文本');
    if (new TextEncoder().encode(schemaText).byteLength > MAX_SCHEMA_BYTES) {
      fail('schema 超过 ' + MAX_SCHEMA_BYTES + ' 字节');
    }
    if (hasImport(schemaText)) fail('不支持 import；请提供自包含 schema');

    const protobuf = runtime();
    const root = new protobuf.Root();
    let parsed;
    try { parsed = protobuf.parse(schemaText, root, { keepCase: true }); }
    catch (error) { fail('schema 语法无效：' + error.message); }
    if (parsed.root !== root) fail('schema root 无效');
    try { root.resolveAll(); }
    catch (error) { fail('schema 类型解析失败：' + error.message); }
    const messages = [];
    function collect(namespace) {
      for (const object of namespace.nestedArray || []) {
        if (object instanceof protobuf.Type) {
          if (object.fieldsArray.some((field) => field.type === 'group')) fail('不支持旧式 group 字段');
          messages.push(object.fullName.replace(/^\./, ''));
        }
        if (object.nestedArray) collect(object);
      }
    }
    collect(root);
    if (!messages.length) fail('schema 中没有 message 类型');
    messages.sort();

    const compiled = {
      types: Object.freeze(messages),
      messages: Object.freeze(messages),
      decode(input, messageType) {
        const bytes = asBytes(input);
        return decodeCompiled(compiled, bytes, messageType);
      },
    };
    Object.freeze(compiled);
    compiledRoots.set(compiled, root);
    return compiled;
  }

  const api = Object.freeze({ MAX_SCHEMA_BYTES, MAX_MESSAGE_BYTES, MAX_FIELDS, MAX_DEPTH, compile,
    decode(schemaOrCompiled, messageType, input) {
      const compiled = typeof schemaOrCompiled === 'string' ? compile(schemaOrCompiled) : schemaOrCompiled;
      if (!compiled || !compiledRoots.has(compiled)) fail('schema 尚未编译');
      return decodeCompiled(compiled, asBytes(input), messageType);
    },
  });
  global.ProtobufSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
