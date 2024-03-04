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
declare namespace PDFKit.Mixins {
  interface TextOptions {
    /** Amount of space to add before the beginning of the text */
    spaceBefore?: number | undefined;
    /** Amount of space to add after the end of the text */
    spaceAfter?: number | undefined;
    /** Amount of space to add before the beginning and after the end of the text */
    spaceAround?: number | undefined;
    /** Always apply spaceBefore */
    forceSpacing?: boolean | undefined;
    /** Try to keep the text together on the same page with whatever follows */
    keepWithNext?: boolean | number | undefined;
    /** Try to keep all of the text on the same page */
    keepTogether?: boolean | undefined;
  }
}
declare module 'pdfkitten' {
  interface DOC extends PDFKit.PDFDocument {
    registerGlobalFont(name: string, path: string): void;
  }
  var doc: DOC;
  export = doc;
}
