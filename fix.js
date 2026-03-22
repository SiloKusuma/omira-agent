const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');
const lines = code.split('\n');

// Fix line 579 - the opening backtick should NOT be escaped
lines[578] = '    const systemPrompt = `Kamu adalah web developer expert. Buat kode lengkap untuk project: "${description}"';

// Line 600 has the closing backtick but it's escaped - it should be just a closing backtick
// Currently: `; (escaped backtick + semicolon)
// Should be: `; (unescaped backtick + semicolon)
lines[599] = '`;';

fs.writeFileSync('index.js', lines.join('\n'));
console.log('Fixed lines 579 and 600');

const result = require('child_process').spawnSync('node', ['--check', 'index.js'], {encoding: 'utf8'});
if (result.stderr) {
  console.log('Syntax error:', result.stderr.substring(0, 500));
} else {
  console.log('No syntax errors!');
}
