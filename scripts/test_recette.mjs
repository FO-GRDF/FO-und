#!/usr/bin/env node
/**
 * FO-UND — Recette : batterie de questions-tests contre le backend en prod.
 * Vérifie que chaque question remonte des sources pertinentes.
 * Usage : node test_recette.mjs [https://fo-und.onrender.com]
 */
const API = process.argv[2] || 'https://fo-und.onrender.com';

const TESTS = [
  { q: "Quel est le montant de l'indemnité d'astreinte à GRDF ?", attendu: /astreinte|pers\s*194|ptc|sujétion/i },
  { q: "Combien d'heures de délégation pour un élu CSE ?", attendu: /cse|délégation|irp/i },
  { q: "Que dit le PERS 793 sur les frais de déplacement ?", attendu: /793|déplacement/i },
  { q: "Comment fonctionne l'intéressement à GRDF ?", attendu: /intéressement/i },
  { q: "Quelles règles pour le télétravail à GRDF ?", attendu: /télétravail|travail à distance/i },
  { q: "Comment est calculée la pension d'invalidité CNIEG ?", attendu: /invalidité|cnieg|pension/i },
  { q: "Quels sont mes droits en cas d'accident du travail ?", attendu: /accident|at\b|pers/i },
  { q: "Accord temps de travail GRDF : durée et cycles ?", attendu: /temps de travail/i },
  { q: "Que prévoit l'accord égalité professionnelle ?", attendu: /égalité/i },
  { q: "Prime mobilités : montant et conditions ?", attendu: /mobilit/i },
  { q: "Abondement PEG PERCOL : quels taux ?", attendu: /abondement|peg|percol/i },
  { q: "Protection du salarié protégé : quelles garanties ?", attendu: /protégé|csp|discipline/i },
  { q: "Congés pour un mariage : combien de jours ?", attendu: /mariage|congé|famili/i },
  { q: "Tarif agent gaz électricité : qui y a droit ?", attendu: /tarif|ane|énergie/i },
  { q: "Médecine du travail : quel suivi pour les agents ?", attendu: /médec|santé/i },
];

let ok = 0, ko = 0;
for (const t of TESTS) {
  try {
    const r = await fetch(`${API}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: t.q }),
    }).then(r => r.json());
    const nb = r.sources?.length || 0;
    const refs = (r.sources || []).map(s => s.ref).join(' | ');
    const pertinent = t.attendu.test(refs) || t.attendu.test(r.answer || '');
    const verdict = nb === 0 ? '❌ AUCUNE SOURCE' : pertinent ? '✅' : '⚠️ sources douteuses';
    if (nb > 0 && pertinent) ok++; else ko++;
    console.log(`${verdict} [${nb} src] ${t.q}`);
    if (nb > 0) console.log(`     ↳ ${refs.slice(0, 150)}`);
  } catch (e) {
    ko++; console.log(`❌ ERREUR ${t.q} :: ${e.message}`);
  }
}
console.log(`\nBilan : ${ok}/${TESTS.length} OK, ${ko} en échec`);
process.exit(ko > 0 ? 1 : 0);
