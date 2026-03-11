if (typeof File === 'undefined') {
  global.File = class File {};
}
if (typeof Blob === 'undefined') {
  global.Blob = class Blob {};
}
if (typeof FormData === 'undefined') {
  global.FormData = class FormData {};
}
