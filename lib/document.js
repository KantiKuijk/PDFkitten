/*
PDFDocument - represents an entire PDF document
By Devon Govett
*/

import stream from 'stream';
import fs from 'fs';
import PDFObject from './object';
import PDFReference from './reference';
import PDFPage from './page';
import PDFNameTree from './name_tree';
import PDFSecurity from './security';
import ColorMixin from './mixins/color';
import VectorMixin from './mixins/vector';
import FontsMixin from './mixins/fonts';
import TextMixin from './mixins/text';
import ImagesMixin from './mixins/images';
import AnnotationsMixin from './mixins/annotations';
import OutlineMixin from './mixins/outline';
import MarkingsMixin from './mixins/markings';
import AcroFormMixin from './mixins/acroform';
import AttachmentsMixin from './mixins/attachments';
import LineWrapper from './line_wrapper';
import SubsetMixin from './mixins/subsets';
import MetadataMixin from './mixins/metadata';

class PDFDocument extends stream.Readable {
  constructor(options = {}) {
    super(options);
    this.options = options;

    // PDF version
    switch (options.pdfVersion) {
      case '1.4':
        this.version = 1.4;
        break;
      case '1.5':
        this.version = 1.5;
        break;
      case '1.6':
        this.version = 1.6;
        break;
      case '1.7':
      case '1.7ext3':
        this.version = 1.7;
        break;
      default:
        this.version = 1.3;
        break;
    }

    // Whether streams should be compressed
    this.compress =
      this.options.compress != null ? this.options.compress : true;

    this._pageBuffer = [];
    this._pageBufferStart = 0;

    // The PDF object store
    this._offsets = [];
    this._waiting = 0;
    this._ended = false;
    this._offset = 0;
    const Pages = this.ref({
      Type: 'Pages',
      Count: 0,
      Kids: []
    });

    const Names = this.ref({
      Dests: new PDFNameTree()
    });

    this._root = this.ref({
      Type: 'Catalog',
      Pages,
      Names
    });

    if (this.options.lang) {
      this._root.data.Lang = new String(this.options.lang);
    }

    // The current page
    this.page = null;

    // Initialize mixins
    this.initMetadata();
    this.initColor();
    this.initVector();
    this.initFonts(options.font);
    this.initText();
    this.initImages();
    this.initOutline();
    this.initMarkings(options);
    this.initSubset(options);

    // Initialize the metadata
    this.info = {
      Producer: 'PDFKit',
      Creator: 'PDFKit',
      CreationDate: new Date()
    };

    if (this.options.info) {
      for (let key in this.options.info) {
        const val = this.options.info[key];
        this.info[key] = val;
      }
    }

    if (this.options.displayTitle) {
      this._root.data.ViewerPreferences = this.ref({
        DisplayDocTitle: true
      });
    }

    // Generate file ID
    this._id = PDFSecurity.generateFileID(this.info);

    // Initialize security settings
    this._security = PDFSecurity.create(this, options);

    // Write the header
    // PDF version
    this._write(`%PDF-${this.version}`);

    // 4 binary chars, as recommended by the spec
    this._write('%\xFF\xFF\xFF\xFF');

    // Add the first page
    if (this.options.autoFirstPage !== false) {
      this.addPage();
    }
  }

  addPage(options) {
    if (options == null) {
      ({ options } = this);
    }

    // end the current page if needed
    if (!this.options.bufferPages) {
      this.flushPages();
    }

    // create a page object
    this.page = new PDFPage(this, options);
    this._pageBuffer.push(this.page);

    // add the page to the object store
    const pages = this._root.data.Pages.data;
    pages.Kids.push(this.page.dictionary);
    pages.Count++;

    // reset x and y coordinates
    this.x = this.page.margins.left;
    this.y = this.page.margins.top;

    // flip PDF coordinate system so that the origin is in
    // the top left rather than the bottom left
    this._ctm = [1, 0, 0, 1, 0, 0];
    this.transform(1, 0, 0, -1, 0, this.page.height);

    this.emit('pageAdded');

    return this;
  }

  continueOnNewPage(options) {
    const pageMarkings = this.endPageMarkings(this.page);

    this.addPage(options);

    this.initPageMarkings(pageMarkings);

    return this;
  }

  bufferedPageRange() {
    return { start: this._pageBufferStart, count: this._pageBuffer.length };
  }

  switchToPage(n) {
    let page;
    if (!(page = this._pageBuffer[n - this._pageBufferStart])) {
      throw new Error(
        `switchToPage(${n}) out of bounds, current buffer covers pages ${
          this._pageBufferStart
        } to ${this._pageBufferStart + this._pageBuffer.length - 1}`
      );
    }

    return (this.page = page);
  }

  flushPages() {
    // this local variable exists so we're future-proof against
    // reentrant calls to flushPages.
    const pages = this._pageBuffer;
    this._pageBuffer = [];
    this._pageBufferStart += pages.length;
    for (let page of pages) {
      this.endPageMarkings(page);
      page.end();
    }
  }

  addNamedDestination(name, ...args) {
    if (args.length === 0) {
      args = ['XYZ', null, null, null];
    }
    if (args[0] === 'XYZ' && args[2] !== null) {
      args[2] = this.page.height - args[2];
    }
    args.unshift(this.page.dictionary);
    this._root.data.Names.data.Dests.add(name, args);
  }

  addNamedEmbeddedFile(name, ref) {
    if (!this._root.data.Names.data.EmbeddedFiles) {
      // disabling /Limits for this tree fixes attachments not showing in Adobe Reader
      this._root.data.Names.data.EmbeddedFiles = new PDFNameTree({
        limits: false
      });
    }

    // add filespec to EmbeddedFiles
    this._root.data.Names.data.EmbeddedFiles.add(name, ref);
  }

  addNamedJavaScript(name, js) {
    if (!this._root.data.Names.data.JavaScript) {
      this._root.data.Names.data.JavaScript = new PDFNameTree();
    }
    let data = {
      JS: new String(js),
      S: 'JavaScript'
    };
    this._root.data.Names.data.JavaScript.add(name, data);
  }

  ref(data) {
    const ref = new PDFReference(this, this._offsets.length + 1, data);
    this._offsets.push(null); // placeholder for this object's offset once it is finalized
    this._waiting++;
    return ref;
  }

  _read() {}
  // do nothing, but this method is required by node

  _write(data) {
    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data + '\n', 'binary');
    }

    this.push(data);
    return (this._offset += data.length);
  }

  addContent(data) {
    this.page.write(data);
    return this;
  }

  _refEnd(ref) {
    this._offsets[ref.id - 1] = ref.offset;
    if (--this._waiting === 0 && this._ended) {
      this._finalize();
      return (this._ended = false);
    }
  }

  write(filename, fn) {
    // print a deprecation warning with a stacktrace
    const err = new Error(`\
PDFDocument#write is deprecated, and will be removed in a future version of PDFKit. \
Please pipe the document into a Node stream.\
`);

    console.warn(err.stack);

    this.pipe(fs.createWriteStream(filename));
    this.end();
    return this.once('end', fn);
  }

  end() {
    this.flushPages();

    this._info = this.ref();
    for (let key in this.info) {
      let val = this.info[key];
      if (typeof val === 'string') {
        val = new String(val);
      }

      let entry = this.ref(val);
      entry.end();

      this._info.data[key] = entry;
    }

    this._info.end();

    for (let name in this._fontFamilies) {
      const font = this._fontFamilies[name];
      font.finalize();
    }

    this.endOutline();
    this.endMarkings();

    if (this.subset) {
      this.endSubset();
    }

    this.endMetadata();

    this._root.end();
    this._root.data.Pages.end();
    this._root.data.Names.end();
    this.endAcroForm();

    if (this._root.data.ViewerPreferences) {
      this._root.data.ViewerPreferences.end();
    }

    if (this._security) {
      this._security.end();
    }

    if (this._waiting === 0) {
      return this._finalize();
    } else {
      return (this._ended = true);
    }
  }

  _finalize() {
    // generate xref
    const xRefOffset = this._offset;
    this._write('xref');
    this._write(`0 ${this._offsets.length + 1}`);
    this._write('0000000000 65535 f ');

    for (let offset of this._offsets) {
      offset = `0000000000${offset}`.slice(-10);
      this._write(offset + ' 00000 n ');
    }

    // trailer
    const trailer = {
      Size: this._offsets.length + 1,
      Root: this._root,
      Info: this._info,
      ID: [this._id, this._id]
    };
    if (this._security) {
      trailer.Encrypt = this._security.dictionary;
    }

    this._write('trailer');
    this._write(PDFObject.convert(trailer));

    this._write('startxref');
    this._write(`${xRefOffset}`);
    this._write('%%EOF');

    // end the stream
    return this.push(null);
  }

  toString() {
    return '[object PDFDocument]';
  }

  /** Fonts **/
  static _registeredGlobalFonts = {};
  static registerGlobalFont(name, src, family) {
    PDFDocument._registeredGlobalFonts[name] = {
      src,
      family
    };
    return this;
  }
  getFontSize() {
    return this._fontSize;
  }
  setFontSize(size) {
    this._fontSize = size;
  }
  getFont() {
    return this._font;
  }
  setFont(font) {
    this._font = font;
  }
}

const mixin = methods => {
  Object.assign(PDFDocument.prototype, methods);
};

/* Metadata */
mixin(MetadataMixin);
PDFDocument.prototype.initMetadata = MetadataMixin.initMetadata;
PDFDocument.prototype.appendXML = MetadataMixin.appendXML;
PDFDocument.prototype._addInfo = MetadataMixin._addInfo;
PDFDocument.prototype.endMetadata = MetadataMixin.endMetadata;
/* Color */
mixin(ColorMixin);
PDFDocument.prototype.initColor = ColorMixin.initColor;
PDFDocument.prototype._normalizeColor = ColorMixin._normalizeColor;
PDFDocument.prototype._setColor = ColorMixin._setColor;
PDFDocument.prototype._setColorCore = ColorMixin._setColorCore;
PDFDocument.prototype._setColorSpace = ColorMixin._setColorSpace;
PDFDocument.prototype._getColorSpace = ColorMixin._getColorSpace;
PDFDocument.prototype.fillColor = ColorMixin.fillColor;
PDFDocument.prototype.strokeColor = ColorMixin.strokeColor;
PDFDocument.prototype.opacity = ColorMixin.opacity;
PDFDocument.prototype.fillOpacity = ColorMixin.fillOpacity;
PDFDocument.prototype.strokeOpacity = ColorMixin.strokeOpacity;
PDFDocument.prototype._doOpacity = ColorMixin._doOpacity;
PDFDocument.prototype.linearGradient = ColorMixin.linearGradient;
PDFDocument.prototype.radialGradient = ColorMixin.radialGradient;
PDFDocument.prototype.pattern = ColorMixin.pattern;
/* Vector */
mixin(VectorMixin);
PDFDocument.prototype.initVector = VectorMixin.initVector;
PDFDocument.prototype.save = VectorMixin.save;
PDFDocument.prototype.restore = VectorMixin.restore;
PDFDocument.prototype.closePath = VectorMixin.closePath;
PDFDocument.prototype.lineWidth = VectorMixin.lineWidth;
PDFDocument.prototype._CAP_STYLES = VectorMixin._CAP_STYLES;
PDFDocument.prototype.lineCap = VectorMixin.lineCap;
PDFDocument.prototype._JOIN_STYLES = VectorMixin._JOIN_STYLES;
PDFDocument.prototype.lineJoin = VectorMixin.lineJoin;
PDFDocument.prototype.miterLimit = VectorMixin.miterLimit;
PDFDocument.prototype.dash = VectorMixin.dash;
PDFDocument.prototype.undash = VectorMixin.undash;
PDFDocument.prototype.moveTo = VectorMixin.moveTo;
PDFDocument.prototype.lineTo = VectorMixin.lineTo;
PDFDocument.prototype.bezierCurveTo = VectorMixin.bezierCurveTo;
PDFDocument.prototype.quadraticCurveTo = VectorMixin.quadraticCurveTo;
PDFDocument.prototype.rect = VectorMixin.rect;
PDFDocument.prototype.roundedRect = VectorMixin.roundedRect;
PDFDocument.prototype.ellipse = VectorMixin.ellipse;
PDFDocument.prototype.circle = VectorMixin.circle;
PDFDocument.prototype.arc = VectorMixin.arc;
PDFDocument.prototype.polygon = VectorMixin.polygon;
PDFDocument.prototype.path = VectorMixin.path;
PDFDocument.prototype._windingRule = VectorMixin._windingRule;
PDFDocument.prototype.fill = VectorMixin.fill;
PDFDocument.prototype.stroke = VectorMixin.stroke;
PDFDocument.prototype.fillAndStroke = VectorMixin.fillAndStroke;
PDFDocument.prototype.clip = VectorMixin.clip;
PDFDocument.prototype.transform = VectorMixin.transform;
PDFDocument.prototype.translate = VectorMixin.translate;
PDFDocument.prototype.rotate = VectorMixin.rotate;
PDFDocument.prototype.scale = VectorMixin.scale;
/* Fonts */
mixin(FontsMixin);
PDFDocument.prototype.initFonts = FontsMixin.initFonts;
PDFDocument.prototype.font = FontsMixin.font;
PDFDocument.prototype.fontSize = FontsMixin.fontSize;
PDFDocument.prototype.currentLineHeight = FontsMixin.currentLineHeight;
PDFDocument.prototype.registerFont = FontsMixin.registerFont;
/* Text */
mixin(TextMixin);
PDFDocument.prototype.initText = TextMixin.initText;
PDFDocument.prototype.lineGap = TextMixin.lineGap;
PDFDocument.prototype.moveDown = TextMixin.moveDown;
PDFDocument.prototype.moveUp = TextMixin.moveUp;
PDFDocument.prototype._text = TextMixin._text;
PDFDocument.prototype.text = TextMixin.text;
PDFDocument.prototype.widthOfString = TextMixin.widthOfString;
PDFDocument.prototype.heightOfString = TextMixin.heightOfString;
PDFDocument.prototype.list = TextMixin.list;
PDFDocument.prototype._initOptions = TextMixin._initOptions;
PDFDocument.prototype._line = TextMixin._line;
PDFDocument.prototype._fragment = TextMixin._fragment;
/* Images */
mixin(ImagesMixin);
PDFDocument.prototype.initImages = ImagesMixin.initImages;
PDFDocument.prototype.image = ImagesMixin.image;
PDFDocument.prototype.openImage = ImagesMixin.openImage;
/* Outlines */
mixin(AnnotationsMixin);
PDFDocument.prototype.annotate = AnnotationsMixin.annotate;
PDFDocument.prototype.note = AnnotationsMixin.note;
PDFDocument.prototype.goTo = AnnotationsMixin.goTo;
PDFDocument.prototype.link = AnnotationsMixin.link;
PDFDocument.prototype._markup = AnnotationsMixin._markup;
PDFDocument.prototype.highlight = AnnotationsMixin.highlight;
PDFDocument.prototype.underline = AnnotationsMixin.underline;
PDFDocument.prototype.strike = AnnotationsMixin.strike;
PDFDocument.prototype.lineAnnotation = AnnotationsMixin.lineAnnotation;
PDFDocument.prototype.rectAnnotation = AnnotationsMixin.rectAnnotation;
PDFDocument.prototype.ellipseAnnotation = AnnotationsMixin.ellipseAnnotation;
PDFDocument.prototype.textAnnotation = AnnotationsMixin.textAnnotation;
PDFDocument.prototype.fileAnnotation = AnnotationsMixin.fileAnnotation;
PDFDocument.prototype._convertRect = AnnotationsMixin._convertRect;
/* Markings */
mixin(OutlineMixin);
PDFDocument.prototype.initOutline = OutlineMixin.initOutline;
PDFDocument.prototype.endOutline = OutlineMixin.endOutline;
/* Markings */
mixin(MarkingsMixin);
PDFDocument.prototype.initMarkings = MarkingsMixin.initMarkings;
PDFDocument.prototype.markContent = MarkingsMixin.markContent;
PDFDocument.prototype.markStructureContent = MarkingsMixin.markStructureContent;
PDFDocument.prototype.endMarkedContent = MarkingsMixin.endMarkedContent;
PDFDocument.prototype.struct = MarkingsMixin.struct;
PDFDocument.prototype.addStructure = MarkingsMixin.addStructure;
PDFDocument.prototype.initPageMarkings = MarkingsMixin.initPageMarkings;
PDFDocument.prototype.endPageMarkings = MarkingsMixin.endPageMarkings;
PDFDocument.prototype.getMarkInfoDictionary =
  MarkingsMixin.getMarkInfoDictionary;
PDFDocument.prototype.getStructTreeRoot = MarkingsMixin.getStructTreeRoot;
PDFDocument.prototype.getStructParentTree = MarkingsMixin.getStructParentTree;
PDFDocument.prototype.createStructParentTreeNextKey =
  MarkingsMixin.createStructParentTreeNextKey;
PDFDocument.prototype.endMarkings = MarkingsMixin.endMarkings;
/* AcroForm */
mixin(AcroFormMixin);
PDFDocument.prototype.initForm = AcroFormMixin.initForm;
PDFDocument.prototype.endAcroForm = AcroFormMixin.endAcroForm;
PDFDocument.prototype._endChild = AcroFormMixin._endChild;
PDFDocument.prototype.formField = AcroFormMixin.formField;
PDFDocument.prototype.formAnnotation = AcroFormMixin.formAnnotation;
PDFDocument.prototype.formText = AcroFormMixin.formText;
PDFDocument.prototype.formPushButton = AcroFormMixin.formPushButton;
PDFDocument.prototype.formCombo = AcroFormMixin.formCombo;
PDFDocument.prototype.formList = AcroFormMixin.formList;
PDFDocument.prototype.formRadioButton = AcroFormMixin.formRadioButton;
PDFDocument.prototype.formCheckbox = AcroFormMixin.formCheckbox;
PDFDocument.prototype._addToParent = AcroFormMixin._addToParent;
PDFDocument.prototype._fieldDict = AcroFormMixin._fieldDict;
PDFDocument.prototype._resolveType = AcroFormMixin._resolveType;
PDFDocument.prototype._resolveFormat = AcroFormMixin._resolveFormat;
PDFDocument.prototype._resolveColors = AcroFormMixin._resolveColors;
PDFDocument.prototype._resolveFlags = AcroFormMixin._resolveFlags;
PDFDocument.prototype._resolveJustify = AcroFormMixin._resolveJustify;
PDFDocument.prototype._resolveFont = AcroFormMixin._resolveFont;
PDFDocument.prototype._resolveStrings = AcroFormMixin._resolveStrings;
/* Attachments */
mixin(AttachmentsMixin);
PDFDocument.prototype.file = AttachmentsMixin.file;
/* Subset */
mixin(SubsetMixin);
PDFDocument.prototype._importSubset = SubsetMixin._importSubset;
PDFDocument.prototype.initSubset = SubsetMixin.initSubset;

PDFDocument.LineWrapper = LineWrapper;

export default PDFDocument;
