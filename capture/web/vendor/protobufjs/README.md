# Vendored protobuf runtimes

These browser assets are pinned copies of the official npm packages, fetched from
the npm registry distribution tarballs. No runtime loader or network access is used.

- `protobuf.min.js`: `protobufjs` 8.8.0, package `protobufjs/-/protobufjs-8.8.0.tgz`.
  Package integrity: `sha512-N3xhQ5yyBx3vQq4gubBfASzYhJGNzeDbjqBpu61g7UVylsN/qyffU96TKWD3GbbLOKF82VGNRNvv1+BFgE31Eg==`.
- `long.js`: `long` 5.3.2, package `long/-/long-5.3.2.tgz`.
  Package integrity: `sha512-mNAgZ1GmyNhD7AuqnTG3/VQ26o760+ZYBPKjPvugO8+nLbYfX6TVpJPseBvopbdY+qpZ/lKUnmEc1LeZYS3QAA==`.

The Long implementation is required so protobuf 64-bit integer values retain
their precision; `protobuf-schema.js` configures it before compiling or decoding.
Load `protobuf.min.js`, then `long.js`, then `protobuf-schema.js` in browser pages.
The upstream BSD-3-Clause license for protobuf.js is included as `LICENSE`;
the Apache-2.0 license for Long is included as `LONG-LICENSE`.

SHA-256 of the vendored runtime files:

```text
14260b088114ea634d95abafe8e7f8bedf1666dcd1e6df94ddd3e0e7c9c63abc  protobuf.min.js
ea6da8d5fff04abc358b94488dbbb7eeb46e5027cc05303b1761cea94bef7821  long.js
```
