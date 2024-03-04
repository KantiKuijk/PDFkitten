declare namespace PDFKit {
  type PDFFontSentinel = {
    name: string;
  };
  interface PDFDocument {
    getFontSize(): number;
    setFontSize(size: number): void;
    getFont(): PDFFontSentinel;
    setFont(font: PDFFontSentinel): void;
  }
}
declare module 'pdfkitten' {
  interface DOC extends PDFKit.PDFDocument {
    registerGlobalFont(name: string, path: string): void;
  }
  var doc: DOC;
  export = doc;
}
