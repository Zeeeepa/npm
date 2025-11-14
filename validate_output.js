'use strict';

/**
 * Output Validator for NPM Registry Index
 * Checks for duplicates and sequence gaps
 */

const fs = require('fs');
const path = require('path');

const outputFile = process.argv[2] || './data/package-index.json';

console.log('═══════════════════════════════════════════════════════');
console.log('NPM Registry Index Validator');
console.log('═══════════════════════════════════════════════════════');
console.log('Reading:', outputFile);

try {
  const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  
  const seen = new Set();
  const duplicates = [];
  const sequenceGaps = [];
  const invalidEntries = [];
  
  data.forEach((entry, idx) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      invalidEntries.push({ index: idx, entry });
      return;
    }
    
    const [pkg, num] = entry;
    
    // Check for duplicates
    if (seen.has(pkg)) {
      duplicates.push({ package: pkg, index: idx, sequenceNumber: num });
    }
    seen.add(pkg);
    
    // Check sequence numbers
    if (num !== idx) {
      sequenceGaps.push({ index: idx, expected: idx, got: num, package: pkg });
    }
  });
  
  console.log('\n📊 VALIDATION RESULTS:');
  console.log('═══════════════════════════════════════════════════════');
  console.log('Total entries:          ', data.length.toLocaleString());
  console.log('Unique packages:        ', seen.size.toLocaleString());
  console.log('Invalid entries:        ', invalidEntries.length, invalidEntries.length === 0 ? '✅' : '❌');
  console.log('Duplicate packages:     ', duplicates.length, duplicates.length === 0 ? '✅' : '❌');
  console.log('Sequence gaps:          ', sequenceGaps.length, sequenceGaps.length === 0 ? '✅' : '❌');
  
  if (invalidEntries.length > 0) {
    console.log('\n❌ Invalid Entries (first 10):');
    invalidEntries.slice(0, 10).forEach(e => {
      console.log(`  Index ${e.index}: ${JSON.stringify(e.entry)}`);
    });
  }
  
  if (duplicates.length > 0) {
    console.log('\n❌ Duplicate Packages (first 10):');
    duplicates.slice(0, 10).forEach(d => {
      console.log(`  "${d.package}" at index ${d.index} (seq: ${d.sequenceNumber})`);
    });
  }
  
  if (sequenceGaps.length > 0) {
    console.log('\n❌ Sequence Gaps (first 10):');
    sequenceGaps.slice(0, 10).forEach(g => {
      console.log(`  Index ${g.index}: expected ${g.expected}, got ${g.got} ("${g.package}")`);
    });
  }
  
  const isValid = invalidEntries.length === 0 && 
                  duplicates.length === 0 && 
                  sequenceGaps.length === 0;
  
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Overall Status:', isValid ? '✅ VALID' : '❌ INVALID');
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Summary statistics
  if (data.length > 0) {
    const first = data[0];
    const last = data[data.length - 1];
    console.log('First package:', first[0], '(seq:', first[1] + ')');
    console.log('Last package: ', last[0], '(seq:', last[1] + ')');
    console.log('Expected range: 0 to', (data.length - 1).toLocaleString());
  }
  
  process.exit(isValid ? 0 : 1);
  
} catch (err) {
  console.error('\n❌ ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
}

