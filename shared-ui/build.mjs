import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { modules } from '../unified-tools/modules.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(resolve(root, 'unified-tools/package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const lucide = require('lucide-react');
const colors = require('@radix-ui/colors');
const names = { download:'Download', downloads:'FolderDown', check:'Check', x:'X', pause:'Pause', play:'Play', settings:'Settings2', chevronLeft:'ChevronLeft', chevronRight:'ChevronRight', chevronDown:'ChevronDown', chevronUp:'ChevronUp', maximize:'Maximize2', minimize:'Minimize2', copy:'Copy', plus:'Plus', minus:'Minus', search:'Search', trash:'Trash2', folder:'Folder', volume:'Volume2', volumeX:'VolumeX', refresh:'RefreshCw', externalLink:'ExternalLink', image:'Image', video:'Video', file:'File', more:'Ellipsis', eye:'Eye', eyeOff:'EyeOff', calendar:'Calendar', list:'List', checkSquare:'SquareCheck', square:'Square', arrowLeft:'ArrowLeft', arrowRight:'ArrowRight', save:'Save', upload:'Upload', sun:'Sun', moon:'Moon', loader:'LoaderCircle', help:'CircleHelp', bookmark:'Bookmark', zoomIn:'ZoomIn', zoomOut:'ZoomOut', link:'Link', printer:'Printer', music:'Music', inbox:'Inbox', alert:'TriangleAlert', film:'Film', external:'ExternalLink' };
const icons = Object.fromEntries(Object.entries(names).map(([name, component]) => [name, renderToStaticMarkup(React.createElement(lucide[component], { 'aria-hidden':true, focusable:false, width:20, height:20, strokeWidth:1.75 }))]));
function tokens(dark) {
  return ['gray','indigo','green','red','amber'].flatMap(name => Object.entries(colors[name + (dark ? 'Dark' : '')]).map(([key,value]) => `--mt-${name}-${key.match(/\d+$/)[0]}:${value};`)).concat(Object.entries(colors[dark ? 'grayDarkA' : 'grayA']).map(([key,value]) => `--mt-gray-a${key.match(/\d+$/)[0]}:${value};`)).join('');
}
const base = await readFile(resolve(here, 'base.css'), 'utf8');
const css = `:root,:host{--mt-on-accent:${colors.whiteA.whiteA12};--mt-overlay:${colors.blackA.blackA10};${tokens(false)}}\n@media(prefers-color-scheme:dark){:root,:host{${tokens(true)}}}\n:root[data-theme="light"],:host([data-theme="light"]){${tokens(false)}}\n:root[data-theme="dark"],:host([data-theme="dark"]){${tokens(true)}}\n${base}`;
const script = `(() => {\n"use strict";\nconst icons=${JSON.stringify(icons)};\nglobalThis.MyToolsUI=Object.freeze({css:${JSON.stringify(css)},icon:name=>icons[name]});\n})();\n`;
const licenses = await Promise.all(['@radix-ui/colors','lucide-react'].map(async name => `${name}\n${await readFile(resolve(root,'unified-tools/node_modules',name,'LICENSE'),'utf8')}`));
for (const module of modules) {
  const folder = resolve(root, module.source);
  await writeFile(resolve(folder,'ui-tokens.css'),css);
  await writeFile(resolve(folder,'ui-kit.js'),script);
  await writeFile(resolve(folder,'UI-LICENSES.txt'),licenses.join('\n\n'));
}
console.log(`Generated shared UI for ${modules.length} extensions`);
