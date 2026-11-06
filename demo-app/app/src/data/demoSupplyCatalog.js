// The demo's MASTER SUPPLY LIST (the Oct 6 call; plan 2026-10-11 §2): about a dozen items in Matt's
// own two groups — "the cleaning agents, which we call the liquids" and "the paper plastic soap" —
// each with a SKU, how it comes and a price, plus two with no category (one with no SKU and no
// price either, SUP-4), so every state of the Catalog tab, a building's switches and the order
// sheet shows on a fresh load. ONE definition for both demo stories that read it: the localStorage
// stub (data/demoStubs.js, which switches each demo building's items on) and the production
// sandbox's manager-day seed (scripts/_lib/managerDaySeed.mjs, which writes only the items its
// buildings use). Dollars here, as the app's shape; the tables hold cents.
//
// Explicit .js on the one import — the node seed loads this file too.
import { seedId } from '../lib/ids.js';

export const DEMO_SUPPLY_GROUPS = Object.freeze({ liquids: 'Liquids', paper: 'Paper, plastic & soap' });

const L = DEMO_SUPPLY_GROUPS.liquids;
const P = DEMO_SUPPLY_GROUPS.paper;
export const DEMO_SUPPLY_CATALOG = Object.freeze([
  { key: 'glass',    sku: 'CL-1001', name: 'Glass cleaner 32 oz',           category: L,    unit: 'each',        unitPrice: 6.80 },
  { key: 'disin',    sku: 'CL-1002', name: 'Disinfectant concentrate',      category: L,    unit: 'gallon',      unitPrice: 24.50 },
  { key: 'floor',    sku: 'CL-1003', name: 'Neutral floor cleaner',         category: L,    unit: 'gallon',      unitPrice: 19.80 },
  { key: 'finish',   sku: 'CL-1004', name: 'Floor finish',                  category: L,    unit: 'gallon',      unitPrice: 26.50 },
  { key: 'restroom', sku: 'CL-1005', name: 'Restroom cleaner 32 oz',        category: L,    unit: 'each',        unitPrice: 7.40 },
  { key: 'steel',    sku: 'CL-1006', name: 'Stainless steel polish',        category: L,    unit: 'each',        unitPrice: 9.90 },
  { key: 'towel',    sku: 'PP-2001', name: 'Paper towels',                  category: P,    unit: 'case of 12',  unitPrice: 28.40 },
  { key: 'tp',       sku: 'PP-2002', name: 'Toilet paper',                  category: P,    unit: 'case of 36',  unitPrice: 41.20 },
  { key: 'liner',    sku: 'PP-2003', name: 'Trash liners 33 gal',           category: P,    unit: 'case of 250', unitPrice: 32.90 },
  { key: 'soap',     sku: 'PP-2004', name: 'Hand soap refill',              category: P,    unit: 'each',        unitPrice: 9.40 },
  { key: 'glove',    sku: 'PP-2005', name: 'Nitrile gloves (L)',            category: P,    unit: 'box of 100',  unitPrice: 11.90 },
  { key: 'urinal',   sku: 'PP-2006', name: 'Urinal screens',                category: P,    unit: 'pack of 10',  unitPrice: 18.30 },
  { key: 'cloth',    sku: 'GN-3001', name: 'Microfiber cloths',             category: null, unit: 'pack of 24',  unitPrice: 14.60 },
  // SUP-4: a price is optional, and so is a SKU — every surface reads "No price" / no SKU for it.
  { key: 'bulb',     sku: null,      name: 'Replacement bulbs (as needed)', category: null, unit: 'each',        unitPrice: null },
].map((c) => Object.freeze(c)));

// The demo stub's catalog id for a key (stable, so a reseed is idempotent).
export const demoSupplyCatalogId = (key) => seedId('sc', key);
export function demoSupplyCatalogItem(key) {
  return DEMO_SUPPLY_CATALOG.find((c) => c.key === key) || null;
}
