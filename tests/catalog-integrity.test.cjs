// Regression checks against the distributed player bundle. The repository does
// not contain the original React source for this player.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bundle = fs.readFileSync('public/assets/index-xerife-catalog-v8.js', 'utf8');
function between(start, end) {
  const a = bundle.indexOf(start), b = bundle.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing ${start}`);
  return bundle.slice(a, b);
}
const context = vm.createContext({ encodeURIComponent, window: { __XERIFE_PROXY__: true }, Mf: () => ({ tmdbId: '10192' }) });
vm.runInContext(between('function Io(', 'function Mv(') + between('function ju(', 'function zh('), context);
const movie = (titulo, urls) => ({kind:'f', titulo, fontes:{dub:urls}});
const wrong = 'https://saimo-tv.pages.dev/api/stream?tipo=movie&id=10192&versao=dub';
assert.equal(context.c5(movie('Shrek Para Sempre', [wrong])).length, 0);
assert.equal(context.c5(movie('Shrek para Sempre: O Capitulo Final', [wrong])).length, 0);
assert.equal(context.c5(movie('Shrek 4', [wrong])).length, 0);
assert.equal(context.c5(movie('Outro filme', [])).length, 0, 'ID TMDB não deve criar fontes automaticamente');
const candidate = context.c5(movie('Outro filme', ['https://example.org/movie.mp4']));
assert.equal(candidate.length, 2);
assert.equal(candidate[0], 'https://example.org/movie.mp4');
assert.ok(candidate[1].includes(encodeURIComponent('https://example.org/movie.mp4')));
const httpSource = 'http://dbonline.tech-cdn.top/movie/example.mp4';
assert.ok(context.c5(movie('Outro filme', [httpSource]))[0].includes(encodeURIComponent(httpSource)), 'não descartar fontes do catálogo por domínio');
assert.ok(!candidate.some(url => url.includes('969681')));
assert.ok(context.c5({kind:'e', urls:['https://example.org/episode.m3u8']}).length);
console.log('Testes de integridade de fontes aprovados.');
