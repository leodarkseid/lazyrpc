const { File, Blob, FormData } = require('undici');

if (typeof global.File === 'undefined') {
  global.File = File || class File {};
}
if (typeof global.Blob === 'undefined') {
  global.Blob = Blob || class Blob {};
}
if (typeof global.FormData === 'undefined') {
  global.FormData = FormData || class FormData {};
}
