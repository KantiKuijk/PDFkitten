import pkg from './package.json';
import babel from 'rollup-plugin-babel';
import copy from 'rollup-plugin-cpy';

const external = [
  'stream',
  'fs',
  'path',
  'url',
  'zlib',
  'fontkit',
  'events',
  'linebreak',
  'png-js',
  'crypto-js',
  'saslprep',
  'jpeg-exif'
];

export default [
  // ES for green browsers
  {
    input: 'lib/document.js',
    external,
    output: {
      name: 'pdfkit',
      file: pkg.main,
      format: 'es',
      sourcemap: true
    },
    plugins: [
      babel({
        babelrc: false,
        presets: [
          [
            '@babel/preset-env',
            {
              modules: false,
              targets: {
                browsers: [
                  'Firefox 57',
                  'Edge 15',
                  'Chrome 60',
                  'iOS 10',
                  'Safari 10'
                ]
              }
            }
          ]
        ]
      }),
      copy({
        files: ['lib/font/data/*.afm', 'lib/color_profiles/*.icc'],
        dest: 'js/data'
      }),
      copy({
        files: ['lib/index.d.ts'],
        dest: 'js'
      })
    ]
  }
];
