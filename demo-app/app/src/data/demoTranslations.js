// DEMO ONLY — the Spanish and Haitian Creole lines the SYSTEM would have written for the demo's
// checklists (CS-850). In the real app the server translates every section and item when a template
// is saved (api/_lib/qc/store saveTemplate → src/lib/checklistI18n fillSchemaTranslations); the demo
// has no server, so its seeded templates carry the lines already, the way a saved template does
// (`source: 'machine'`), held to the term list (docs/i18n/term-list.md). One Spanish line is the
// office's own wording (`OFFICE_WORDING`), so the editor's Translations view shows an "Edited" line.
// Imported only by data/demoStubs.js.
import { TRANSLATOR_VERSION } from '../lib/checklistI18n.js';

const LINES = {
  'Close-Out': ['Cierre', 'Fèmen'],
  'Lights off': ['Luces apagadas', 'Limyè etenn'],
  'All doors locked': ['Todas las puertas cerradas con llave', 'Tout pòt fèmen a kle'],
  'Alarm set': ['Alarma activada', 'Alam aktive'],
  'Cart cleaned & restocked': ['Carrito limpio y reabastecido', 'Charyo netwaye epi ranpli'],
  'Trash taken to dumpster': ['Basura llevada al contenedor', 'Fatra pote nan gwo poubèl la'],
  'Floor Care': ['Cuidado de pisos', 'Swen planche'],
  'Hard floors swept & dust-mopped': ['Pisos duros barridos y trapeados en seco', 'Planche di yo bale epi pase mòp sèk'],
  'Hard floors mopped': ['Pisos duros trapeados', 'Planche di yo pase mòp'],
  'Carpets & entry mats vacuumed': ['Alfombras y tapetes de entrada aspirados', 'Tapi ak tapi antre yo pase aspiratè'],
  'Spots & spills spot-treated': ['Manchas y derrames tratados', 'Tach ak sa ki tonbe yo trete'],
  'Edges, corners & baseboards detailed': ['Bordes, esquinas y zócalos detallados', 'Bò, kwen ak plent yo netwaye an detay'],
  'Entrance & Lobby': ['Entrada y vestíbulo', 'Antre ak lobi'],
  'Entry glass, doors & frames cleaned inside and out': ['Vidrios, puertas y marcos de la entrada limpios por dentro y por fuera', 'Vit, pòt ak ankadreman antre a netwaye anndan kou deyò'],
  'Walk-off mats vacuumed and straightened': ['Tapetes de entrada aspirados y acomodados', 'Tapi pye yo pase aspiratè epi ranje'],
  'Lobby floor swept, mopped & buffed': ['Piso del vestíbulo barrido, trapeado y pulido', 'Planche lobi a bale, pase mòp epi poli'],
  'Seating, side tables & reception counter wiped': ['Asientos, mesas auxiliares y mostrador de recepción limpiados', 'Chèz, ti tab ak kontwa resepsyon an siye'],
  'Trash & recycling emptied, liners replaced': ['Basura y reciclaje vaciados, bolsas reemplazadas', 'Fatra ak resiklaj vide, sache yo ranplase'],
  'Restrooms': ['Baños', 'Twalèt'],
  'Toilets & urinals descaled and sanitized inside and out': ['Inodoros y urinarios desincrustados y desinfectados por dentro y por fuera', 'Twalèt ak pisotyè yo dekrase epi dezenfekte anndan kou deyò'],
  'Sinks, faucets & countertops disinfected': ['Lavabos, grifos y encimeras desinfectados', 'Lavabo, wobinè ak kontwa yo dezenfekte'],
  'Mirrors & stainless polished streak-free': ['Espejos y acero inoxidable pulidos sin rayas', 'Glas ak asye pwòp yo poli san tras'],
  'Floors swept and mopped with disinfectant': ['Pisos barridos y trapeados con desinfectante', 'Planche yo bale epi pase mòp ak dezenfektan'],
  'Stall partitions & doors wiped down': ['Divisiones y puertas de los cubículos limpiadas', 'Separasyon ak pòt kabin yo siye'],
  'Soap, paper towels & toilet paper restocked': ['Jabón, toallas de papel y papel higiénico repuestos', 'Savon, sèvyèt papye ak papye ijyenik ranpli'],
  'Offices & Workstations': ['Oficinas y puestos de trabajo', 'Biwo ak pòs travay'],
  'Desks & horizontal surfaces dusted around belongings': ['Escritorios y superficies horizontales sin polvo, alrededor de las pertenencias', 'Biwo ak sifas plat yo retire pousyè alantou afè moun yo'],
  'High-touch points sanitized — handles, switches, phones': ['Puntos de contacto frecuente desinfectados: manijas, interruptores, teléfonos', 'Kote moun manyen souvan yo dezenfekte: manch, entèwiptè, telefòn'],
  'Under-desk trash & recycling emptied': ['Basura y reciclaje bajo los escritorios vaciados', 'Fatra ak resiklaj anba biwo yo vide'],
  'Carpets vacuumed, hard floors dust-mopped': ['Alfombras aspiradas, pisos duros trapeados en seco', 'Tapi yo pase aspiratè, planche di yo pase mòp sèk'],
  'Interior glass partitions spot-cleaned': ['Divisiones de vidrio interiores limpiadas donde hacía falta', 'Separasyon vit anndan yo netwaye kote ki te sal'],
  'Break Room & Kitchen': ['Sala de descanso y cocina', 'Sal repo ak kwizin'],
  'Counters, backsplash & tables wiped and sanitized': ['Encimeras, salpicadero y mesas limpiados y desinfectados', 'Kontwa, miray dèyè lavabo ak tab yo siye epi dezenfekte'],
  'Sink scrubbed and faucet polished': ['Fregadero restregado y grifo pulido', 'Lavabo fwote epi wobinè poli'],
  'Microwave, fridge exterior & appliance fronts cleaned': ['Microondas, exterior del refrigerador y frentes de los electrodomésticos limpios', 'Mikwo-ond, deyò frijidè ak devan aparèy yo netwaye'],
  'Cabinet fronts & handles wiped': ['Frentes y manijas de los gabinetes limpiados', 'Devan ak manch kabinè yo siye'],
  'Floor swept and mopped': ['Piso barrido y trapeado', 'Planche bale epi pase mòp'],
  'Trash, recycling & compost emptied, liners replaced': ['Basura, reciclaje y compost vaciados, bolsas reemplazadas', 'Fatra, resiklaj ak konpòs vide, sache yo ranplase'],
  'Conference Rooms': ['Salas de reuniones', 'Sal reyinyon'],
  'Conference tables wiped and chairs pushed in': ['Mesas de reuniones limpiadas y sillas acomodadas', 'Tab reyinyon yo siye epi chèz yo ranje'],
  'Glass walls & doors cleaned': ['Paredes y puertas de vidrio limpias', 'Miray ak pòt vit yo netwaye'],
  'AV surfaces & remotes dusted (nothing unplugged)': ['Superficies audiovisuales y controles remotos sin polvo (sin desenchufar nada)', 'Sifas odyovizyèl ak telekòmand yo retire pousyè (pa debranche anyen)'],
  'Floors vacuumed or mopped': ['Pisos aspirados o trapeados', 'Planche yo pase aspiratè oswa mòp'],
  'Hallways & Stairwells': ['Pasillos y escaleras', 'Koridò ak eskalye'],
  'Floors swept, mopped & edges detailed': ['Pisos barridos, trapeados y bordes detallados', 'Planche yo bale, pase mòp epi bò yo netwaye an detay'],
  'Handrails & door hardware sanitized': ['Pasamanos y herrajes de las puertas desinfectados', 'Ranp ak pyès metal pòt yo dezenfekte'],
  'Directory glass & wall signage wiped': ['Vidrio del directorio y letreros de pared limpiados', 'Vit anyè a ak pankat sou miray yo siye'],
  'Scuffs & marks spot-cleaned from walls': ['Rozaduras y marcas limpiadas de las paredes', 'Mak ak tras sou miray yo netwaye'],
  'All hard floors swept & dust-mopped': ['Todos los pisos duros barridos y trapeados en seco', 'Tout planche di yo bale epi pase mòp sèk'],
  'Hard floors mopped with correct dilution': ['Pisos duros trapeados con la dilución correcta', 'Planche di yo pase mòp ak bon dilisyon an'],
  'All carpets & entry mats vacuumed': ['Todas las alfombras y tapetes de entrada aspirados', 'Tout tapi ak tapi antre yo pase aspiratè'],
  'Windows & Glass': ['Ventanas y vidrios', 'Fenèt ak vit'],
  'Interior windows & sills cleaned': ['Ventanas interiores y alféizares limpios', 'Fenèt anndan ak rebò yo netwaye'],
  'Glass partitions & doors polished': ['Divisiones y puertas de vidrio pulidas', 'Separasyon ak pòt vit yo poli'],
  'Fingerprints & smudges removed from glass surfaces': ['Huellas y manchas quitadas de las superficies de vidrio', 'Mak dwèt ak tach retire sou sifas vit yo'],
  'Supplies & Restock': ['Suministros y reposición', 'Founiti ak ranplisaj'],
  'Paper products restocked at all dispensers': ['Productos de papel repuestos en todos los dispensadores', 'Pwodui papye ranpli nan tout distribitè yo'],
  'Hand soap & sanitizer refilled': ['Jabón de manos y desinfectante rellenados', 'Savon men ak dezenfektan ranpli'],
  'Spare liners staged at each station': ['Bolsas de repuesto listas en cada estación', 'Sache rezèv pare nan chak estasyon'],
  'Low-stock items noted for the supply request': ['Artículos con poco inventario anotados para la solicitud de suministros', 'Atik ki prèske fini yo note pou demann founiti a'],
  'Final Walkthrough': ['Recorrido final', 'Dènye tou verifikasyon'],
  'Lights off in unoccupied areas': ['Luces apagadas en las áreas desocupadas', 'Limyè etenn nan zòn ki vid yo'],
  'All entry doors & windows secured': ['Todas las puertas de entrada y ventanas aseguradas', 'Tout pòt antre ak fenèt yo sekirize'],
  'Alarm armed per site instructions': ['Alarma activada según las instrucciones del sitio', 'Alam aktive dapre enstriksyon sit la'],
  'Cart cleaned, restocked & stored': ['Carrito limpio, reabastecido y guardado', 'Charyo netwaye, ranpli epi sere'],
  'All trash taken to the dumpster': ['Toda la basura llevada al contenedor', 'Tout fatra pote nan gwo poubèl la'],
};
// The templates' NAMES, which the system translates like their lines (CS-850).
const NAMES = {
  'Nightly Close-Out Checklist': ['Lista de verificación de cierre nocturno', 'Lis verifikasyon fèmen chak swa'],
  'Floor Care Checklist': ['Lista de verificación de cuidado de pisos', 'Lis verifikasyon swen planche'],
  'Full Facility Deep-Clean Checklist': ['Lista de verificación de limpieza profunda de toda la instalación', 'Lis verifikasyon netwayaj an pwofondè tout enstalasyon an'],
  'Nightly Janitorial QC': ['Control de calidad de limpieza nocturna', 'Kontwòl kalite netwayaj chak swa'],
  'Restroom Deep-Clean QC': ['Control de calidad de limpieza profunda de baños', 'Kontwòl kalite netwayaj an pwofondè twalèt'],
};
// The office's own Spanish for one line (it stays while the English does).
const OFFICE_WORDING = { 'Alarm set': { es: 'Alarma puesta y comprobada' } };

// A machine line carries the translator version that made it, as the server's do (CS-856).
const entry = (label, en, source) => (source === 'machine' ? { label, en, source, v: TRANSLATOR_VERSION } : { label, en, source });
function translated(node) {
  const line = LINES[node.label];
  if (!line) return node;
  const own = OFFICE_WORDING[node.label] || {};
  return {
    ...node,
    i18n: {
      es: own.es ? entry(own.es, node.label, 'human') : entry(line[0], node.label, 'machine'),
      ht: own.ht ? entry(own.ht, node.label, 'human') : entry(line[1], node.label, 'machine'),
    },
  };
}
// A schema with every section and item the demo has lines for carrying them.
export function withDemoTranslations(schema) {
  return { ...schema, areas: (schema.areas || []).map((a) => ({ ...translated(a), items: (a.items || []).map(translated) })) };
}
// A template NAME's lines (the row's `name_i18n` and the schema's `nameI18n`), or null.
export function demoNameTranslations(name) {
  const line = NAMES[name];
  return line ? { es: entry(line[0], name, 'machine'), ht: entry(line[1], name, 'machine') } : null;
}
