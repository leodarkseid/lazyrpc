// Node 18+ natively supports Blob and File via the buffer module, but lacks String.prototype.toWellFormed
if (typeof String.prototype.toWellFormed === 'undefined') {
  String.prototype.toWellFormed = function() {
    return String(this); // our test payloads are well-formed, so naive polyfill prevents Undici crash
  };
}

const { Blob, File } = require('node:buffer');

// 1. We MUST attach File and Blob to the global scope FIRST.
if (typeof global.Blob === 'undefined') {
  global.Blob = Blob;
}
if (typeof global.File === 'undefined') {
  global.File = File;
}

// 2. NOW it is safe to require undici, because it will see global.File
const { FormData } = require('undici');
if (typeof global.FormData === 'undefined') {
  global.FormData = FormData;
}
