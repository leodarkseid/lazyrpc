// Node 18+ natively supports Blob and File via the buffer module
const { Blob, File } = require('buffer');
// FormData is natively available globally in Node 18+, but if Jest stripped it:
const { FormData } = require('undici'); // Wait, FormData is safe from undici, but File/Blob were the crashes.

if (typeof global.Blob === 'undefined') {
  global.Blob = Blob || require('node:buffer').Blob;
}
if (typeof global.File === 'undefined') {
  global.File = File || require('node:buffer').File;
}
if (typeof global.FormData === 'undefined') {
  global.FormData = typeof FormData !== 'undefined' ? FormData : class FormData {};
}
