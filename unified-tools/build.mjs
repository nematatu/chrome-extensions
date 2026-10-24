import { readFile, writeFile, mkdir, rm, copyFile, readdir, mkdtemp, rename } from 'node:fs/promises';
import { dirname, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { modules } from './modules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const output = resolve(process.argv[2] || resolve(root, 'dist/my-tools'));
if (output === root || relative(root, output) === '' || root.startsWith(output + '/')) throw new Error('Unsafe output directory');
const ignored = new Set(['node_modules', 'dist', 'test-results', '.git', '.audit', '.agents', '.codex']);
async function manifestRoots(folder = root) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.my-tools-build-')) found.push(...await manifestRoots(resolve(folder, entry.name)));
    else if (entry.isFile() && entry.name === 'manifest.json') found.push(relative(root, folder));
  }
  return found.sort();
}
if (JSON.stringify(await manifestRoots()) !== JSON.stringify(modules.map(module => module.source).sort())) throw new Error('Source manifests and module registry differ');
const safeAsset = file => typeof file === 'string' && file.length && !file.startsWith('/') && file.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');
const asset = (id, file) => `modules/${id}/${file}`;
const identity = JSON.parse(await readFile(resolve(here, 'identity.json'), 'utf8'));
const registrations = [], permissions = new Set(['scripting', 'storage']), hosts = new Set(), optionalPermissions = new Set(), optionalHosts = new Set(), resources = [], commands = {}, policies = new Set();
const sources = [], ids = new Set();
for (const module of modules) {
  if (!/^[a-z][a-z0-9]*$/.test(module.id) || ids.has(module.id)) throw new Error('Invalid module ID');
  ids.add(module.id);
  if (!safeAsset(module.source) || module.files.some(file => !safeAsset(file))) throw new Error('Unsafe module asset');
  const manifest = JSON.parse(await readFile(resolve(root, module.source, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.background?.type || manifest.background?.service_worker !== module.worker) throw new Error('Unsupported worker');
  const referenced = [module.worker, module.popup, module.options, module.offscreen].filter(Boolean);
  for (const file of referenced) if (!module.files.includes(file)) throw new Error('Module entrypoint missing from allowlist');
  for (const permission of manifest.permissions || []) if (permission !== 'windows') permissions.add(permission);
  for (const permission of manifest.optional_permissions || []) optionalPermissions.add(permission);
  for (const host of manifest.host_permissions || []) hosts.add(host);
  for (const host of manifest.optional_host_permissions || []) optionalHosts.add(host);
  if (manifest.content_security_policy?.extension_pages) policies.add(manifest.content_security_policy.extension_pages);
  for (const [key, value] of Object.entries(manifest.commands || {})) {
    const name = key === '_execute_action' && module.id === 'birdscore' ? 'birdscore-open' : `${module.id}-${key}`;
    if (commands[name]) throw new Error('Conflicting command');
    commands[name] = value;
  }
  for (const resource of manifest.web_accessible_resources || []) {
    for (const file of resource.resources) if (!module.files.includes(file)) throw new Error('Web accessible asset missing from allowlist');
    resources.push({ ...resource, resources: resource.resources.map(file => asset(module.id, file)) });
  }
  const mainFiles = new Set([...(manifest.web_accessible_resources || []).flatMap(resource => resource.resources).filter(file => file.endsWith('.js')), ...(manifest.content_scripts || []).filter(script => script.world === 'MAIN').flatMap(script => script.js || [])]);
  const isolatedShared = new Set((manifest.content_scripts || []).filter(script => script.world !== 'MAIN').flatMap(script => script.js || []).filter(file => mainFiles.has(file)));
  for (const [index, script] of (manifest.content_scripts || []).entries()) {
    const allowed = ['matches', 'exclude_matches', 'js', 'css', 'world', 'run_at', 'all_frames', 'match_origin_as_fallback', 'match_about_blank'];
    if (Object.keys(script).some(key => !allowed.includes(key)) || script.match_about_blank) throw new Error('Unsupported content script option');
    if ([...(script.js || []), ...(script.css || [])].some(file => !module.files.includes(file))) throw new Error('Content script asset missing from allowlist');
    script.matches.forEach(host => hosts.add(host));
    const world = script.world || 'ISOLATED';
    if (world === 'MAIN') script.js?.forEach(file => mainFiles.add(file));
    registrations.push({ id: `tools-${module.id}-${index}`, module: module.id, matches: script.matches,
      js: [...(world === 'ISOLATED' ? ['config.js', 'client.js'] : []), ...(script.js || []).map(file => asset(module.id, world !== 'MAIN' && isolatedShared.has(file) ? '__isolated__/' + file : file))], world, runAt: script.run_at || 'document_idle',
      ...(script.css && { css: script.css.map(file => asset(module.id, file)) }),
      ...(script.exclude_matches && { excludeMatches: script.exclude_matches }),
      ...(script.all_frames !== undefined && { allFrames: script.all_frames }),
      ...(script.match_origin_as_fallback !== undefined && { matchOriginAsFallback: script.match_origin_as_fallback }) });
  }
  sources.push({ module, mainFiles, isolatedShared, description: manifest.description || "", matches: [...new Set((manifest.content_scripts || []).flatMap(script => script.matches))] });
}
if (policies.size > 1) throw new Error('Conflicting extension CSP');
try {
  const entries = await readdir(output);
  if (entries.length && !entries.includes('.my-tools-generated')) throw new Error('Refusing to replace a directory not generated by My Tools');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(resolve(dirname(output), '.my-tools-build-'));
const backup = staging + '-previous';
let previous = false;
try {
  await writeFile(resolve(staging, '.my-tools-generated'), 'My Tools build output\n');
  for (const file of ['runtime.js', 'client.js', 'portable.js', 'transfer.js', 'offscreen-host.js', 'popup.html', 'popup.js', 'popup.css']) await copyFile(resolve(here, file), resolve(staging, file));
  for (const { module, mainFiles, isolatedShared } of sources) {
    const adapter = `const chrome = globalThis.MyToolsRuntime?.moduleChrome ? globalThis.MyToolsRuntime.moduleChrome(${JSON.stringify(module.id)}) : globalThis.MyToolsClient.moduleChrome(${JSON.stringify(module.id)});\n`;
    for (const file of module.files) {
      const target = resolve(staging, asset(module.id, file));
      await mkdir(dirname(target), { recursive: true });
      if (!/\.(?:js|mjs|html)$/.test(file) || file.startsWith('vendor/') || mainFiles.has(file)) {
        await copyFile(resolve(root, module.source, file), target);
        continue;
      }
      let source = await readFile(resolve(root, module.source, file), 'utf8');
      if (file.endsWith('.html')) {
        const base = posix.dirname(asset(module.id, file));
        const prelude = ['config.js', 'client.js'].map(name => `<script src="${posix.relative(base, name)}"></script>`).join('\n');
        const firstScript = source.search(/<script\b/i);
        if (firstScript !== -1) source = source.slice(0, firstScript) + prelude + '\n' + source.slice(firstScript);
        else if (/<\/head>/i.test(source)) source = source.replace(/<\/head>/i, prelude + '</head>');
        else source += '\n' + prelude;
      } else if (file.endsWith('.mjs')) source = adapter + source;
      else {
        const imports = file === module.worker ? `const importScripts = (...paths) => globalThis.importScripts(...paths.map(path => ${JSON.stringify('modules/' + module.id + '/')} + path));\n` : '';
        source = `(() => {\n${adapter}${imports}${source}\n})();\n`;
      }
      await writeFile(target, source);
    }
    for (const file of isolatedShared) {
      const target = resolve(staging, asset(module.id, '__isolated__/' + file));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(staging, asset(module.id, file)), target);
    }
  }
  const config = { modules: sources.map(({ module, matches, description }) => ({ ...module, matches, description })), registrations };
  await writeFile(resolve(staging, 'config.js'), `globalThis.MyToolsConfig = ${JSON.stringify(config)};\n`);
  await writeFile(resolve(staging, 'worker.js'), `importScripts("config.js", "client.js", "runtime.js", "portable.js", "transfer.js");\nglobalThis.MyToolsRuntime.boot(globalThis.MyToolsConfig);\nimportScripts(${modules.filter(module => module.worker).map(module => JSON.stringify(asset(module.id, module.worker))).join(', ')});\n`);
  await writeFile(resolve(staging, 'offscreen.html'), `<!doctype html><html><head><meta charset="utf-8"><script src="config.js"></script><script src="offscreen-host.js"></script></head><body>${modules.filter(module => module.offscreen).map(module => `<iframe src="${asset(module.id, module.offscreen)}"></iframe>`).join('')}</body></html>\n`);
  await writeFile(resolve(staging, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'My Tools', version: '2.0.0', description: 'このリポジトリの19機能をまとめて管理します。', key: identity.key, minimum_chrome_version: '120', permissions: [...permissions].sort(), host_permissions: [...hosts].sort(),
    ...(optionalPermissions.size && { optional_permissions: [...optionalPermissions].filter(value => !permissions.has(value)).sort() }),
    ...(optionalHosts.size && { optional_host_permissions: [...optionalHosts].sort() }),
    ...(resources.length && { web_accessible_resources: resources }), ...(Object.keys(commands).length && { commands }),
    ...(policies.size && { content_security_policy: { extension_pages: [...policies][0] } }),
    incognito: 'not_allowed', background: { service_worker: 'worker.js' }, action: { default_title: 'My Tools', default_popup: 'popup.html' }, options_ui: { page: 'popup.html', open_in_tab: true } }, null, 2) + '\n');
  const scripts = ['config.js', 'client.js', 'runtime.js', 'portable.js', 'transfer.js', 'offscreen-host.js', 'popup.js', 'worker.js', ...modules.flatMap(module => module.files.filter(file => /\.(?:js|mjs)$/.test(file)).map(file => asset(module.id, file)))];
  for (const file of scripts) {
    const target = resolve(staging, file);
    if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
      if (result.status !== 0) throw new SyntaxError(result.stderr);
    } else new Script(await readFile(target, 'utf8'), { filename: file });
  }
  try { await rename(output, backup); previous = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staging, output); }
  catch (error) {
    if (previous) await rename(backup, output);
    throw error;
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
if (previous) await rm(backup, { recursive: true, force: true });
console.log(`Built ${output}`);
