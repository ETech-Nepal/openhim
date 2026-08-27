// Jaro-Winkler similarity — the comparison JeMPI's link config specifies for every
// demographic field (`"comparison": "JARO_WINKLER_SIMILARITY"`). Implemented here so
// our scores are comparable to the ones JeMPI's linker would produce.

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  // Two characters may only be considered matching if they are within this window.
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aFlags = new Array(la).fill(false);
  const bFlags = new Array(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, lb);
    for (let j = start; j < end; j++) {
      if (bFlags[j] || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Half the number of matched-but-out-of-order characters.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

// Winkler's modification: boost strings sharing a common prefix (capped at 4 chars),
// which suits names — the usual case for our demographic fields.
export function jaroWinkler(a, b, scalingFactor = 0.1) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  const j = jaro(s1, s2);
  if (j === 0) return 0;

  let prefix = 0;
  const max = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < max; i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return j + prefix * scalingFactor * (1 - j);
}
