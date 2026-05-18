// Node 18+ natively supports Blob and File via the buffer module, but lacks String.prototype.toWellFormed
if (typeof String.prototype.toWellFormed === 'undefined') {
  String.prototype.toWellFormed = function() {
    return String(this); // our test payloads are well-formed, so naive polyfill prevents Undici crash
  };
}

const { Blob, File } = require('node:buffer');
const { TextDecoder, TextEncoder } = require('node:util');
const {
  ReadableStream,
  TransformStream,
  WritableStream,
} = require('node:stream/web');
const { MessageChannel, MessagePort } = require('node:worker_threads');

// 1. We MUST attach File and Blob to the global scope FIRST.
if (typeof global.Blob === 'undefined') {
  global.Blob = Blob;
}
if (typeof global.File === 'undefined') {
  global.File = File;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}
if (typeof global.ReadableStream === 'undefined') {
  global.ReadableStream = ReadableStream;
}
if (typeof global.TransformStream === 'undefined') {
  global.TransformStream = TransformStream;
}
if (typeof global.WritableStream === 'undefined') {
  global.WritableStream = WritableStream;
}
if (typeof global.MessageChannel === 'undefined') {
  global.MessageChannel = MessageChannel;
}
if (typeof global.MessagePort === 'undefined') {
  global.MessagePort = MessagePort;
}

// 2. NOW it is safe to require undici, because it will see browser-compatible globals.
const { FormData } = require('undici');
if (typeof global.FormData === 'undefined') {
  global.FormData = FormData;
}
