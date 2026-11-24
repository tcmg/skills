export type SpellLanguage = 'en-AU' | 'en-GB' | 'en-US' | 'off';

export interface SpellLanguageOption {
  value: SpellLanguage;
  label: string;
  triggerLabel: string;
  subtitle?: string;
}

export const DEFAULT_SPELL_LANGUAGE: SpellLanguage = 'en-AU';

export const SPELL_LANGUAGE_OPTIONS: SpellLanguageOption[] = [
  { value: 'en-AU', label: 'Australian English', triggerLabel: 'AU', subtitle: 'en-AU · -ise / -our' },
  { value: 'en-GB', label: 'British English', triggerLabel: 'UK', subtitle: 'en-GB · -ise / -our' },
  { value: 'en-US', label: 'US English', triggerLabel: 'US', subtitle: 'en-US · -ize / -or' },
  { value: 'off', label: 'Off', triggerLabel: 'Off', subtitle: 'Disable auto-correct & spellcheck' }
];

// High-confidence common English typos (safe for technical & editorial writing).
const COMMON_TYPOS: Record<string, string> = {
  abotu: 'about',
  accomodate: 'accommodate',
  acheive: 'achieve',
  acheived: 'achieved',
  adn: 'and',
  afer: 'after',
  againt: 'against',
  alot: 'a lot',
  alwyas: 'always',
  amke: 'make',
  anoter: 'another',
  apparantly: 'apparently',
  arent: "aren't",
  arguement: 'argument',
  aroudn: 'around',
  beacuse: 'because',
  becuase: 'because',
  befroe: 'before',
  begining: 'beginning',
  beleive: 'believe',
  betwen: 'between',
  calender: 'calendar',
  cant: "can't",
  catagory: 'category',
  chagne: 'change',
  collegue: 'colleague',
  comapny: 'company',
  commited: 'committed',
  comparision: 'comparison',
  concensus: 'consensus',
  consistant: 'consistent',
  coudl: 'could',
  couldnt: "couldn't",
  definately: 'definitely',
  dependancy: 'dependency',
  dependancies: 'dependencies',
  developement: 'development',
  didnt: "didn't",
  diffrent: 'different',
  disapear: 'disappear',
  docuemnt: 'document',
  doesnt: "doesn't",
  dont: "don't",
  embarass: 'embarrass',
  enviroment: 'environment',
  existance: 'existence',
  exmaple: 'example',
  experiance: 'experience',
  explaination: 'explanation',
  feautre: 'feature',
  foriegn: 'foreign',
  freind: 'friend',
  fucntion: 'function',
  goverment: 'government',
  grammer: 'grammar',
  happend: 'happened',
  hasnt: "hasn't",
  havent: "haven't",
  hte: 'the',
  immediatly: 'immediately',
  improtant: 'important',
  independant: 'independent',
  infomation: 'information',
  intresting: 'interesting',
  isnt: "isn't",
  jsut: 'just',
  knowlege: 'knowledge',
  knwo: 'know',
  langauge: 'language',
  liek: 'like',
  maintenence: 'maintenance',
  mesage: 'message',
  millenium: 'millennium',
  mispell: 'misspell',
  mkae: 'make',
  moduel: 'module',
  neccessary: 'necessary',
  noticable: 'noticeable',
  nwo: 'now',
  occured: 'occurred',
  occurence: 'occurrence',
  pacakge: 'package',
  parrallel: 'parallel',
  peopel: 'people',
  performence: 'performance',
  persistant: 'persistent',
  posession: 'possession',
  prefered: 'preferred',
  priviledge: 'privilege',
  probelm: 'problem',
  proejct: 'project',
  publically: 'publicly',
  quesiton: 'question',
  realy: 'really',
  reccomend: 'recommend',
  recieve: 'receive',
  recieved: 'received',
  recieving: 'receiving',
  refered: 'referred',
  relevent: 'relevant',
  rememeber: 'remember',
  repsonse: 'response',
  resistence: 'resistance',
  responsiblity: 'responsibility',
  resturant: 'restaurant',
  rythm: 'rhythm',
  secratary: 'secretary',
  seperate: 'separate',
  seperated: 'separated',
  servcie: 'service',
  shoudl: 'should',
  shouldnt: "shouldn't",
  similiar: 'similar',
  sincerly: 'sincerely',
  speach: 'speech',
  succesful: 'successful',
  suprise: 'surprise',
  sytsem: 'system',
  taht: 'that',
  teh: 'the',
  temperture: 'temperature',
  thier: 'their',
  thnik: 'think',
  tihs: 'this',
  todya: 'today',
  tommorow: 'tomorrow',
  tounge: 'tongue',
  truely: 'truly',
  unfortunatly: 'unfortunately',
  untill: 'until',
  usefull: 'useful',
  vaccum: 'vacuum',
  verison: 'version',
  waht: 'what',
  wasnt: "wasn't",
  wehn: 'when',
  werent: "weren't",
  whcih: 'which',
  wierd: 'weird',
  wiht: 'with',
  wokr: 'work',
  wont: "won't",
  woudl: 'would',
  wouldnt: "wouldn't",
  writting: 'writing',
  yera: 'year',
  yoru: 'your',
  yuo: 'you'
};

// US -> Commonwealth (AU / GB) spelling pairs.
// Note: 'program' is intentionally excluded because Australian English uses 'program'.
const US_TO_COMMONWEALTH: Record<string, string> = {
  acknowledgment: 'acknowledgement',
  aging: 'ageing',
  airplane: 'aeroplane',
  aluminum: 'aluminium',
  analog: 'analogue',
  analyze: 'analyse',
  analyzed: 'analysed',
  analyzing: 'analysing',
  apologize: 'apologise',
  apologized: 'apologised',
  artifact: 'artefact',
  artifacts: 'artefacts',
  authorize: 'authorise',
  authorized: 'authorised',
  authorization: 'authorisation',
  behavior: 'behaviour',
  behavioral: 'behavioural',
  behaviors: 'behaviours',
  caliber: 'calibre',
  canceled: 'cancelled',
  canceling: 'cancelling',
  candor: 'candour',
  catalog: 'catalogue',
  categorize: 'categorise',
  categorized: 'categorised',
  center: 'centre',
  centered: 'centred',
  centering: 'centring',
  centers: 'centres',
  centralize: 'centralise',
  centralized: 'centralised',
  characterize: 'characterise',
  characterized: 'characterised',
  checkered: 'chequered',
  color: 'colour',
  colored: 'coloured',
  coloring: 'colouring',
  colors: 'colours',
  criticize: 'criticise',
  criticized: 'criticised',
  customize: 'customise',
  customizable: 'customisable',
  customized: 'customised',
  customizing: 'customising',
  defense: 'defence',
  dialog: 'dialogue',
  emphasize: 'emphasise',
  emphasized: 'emphasised',
  endeavor: 'endeavour',
  enroll: 'enrol',
  enrollment: 'enrolment',
  favorite: 'favourite',
  favorites: 'favourites',
  fiber: 'fibre',
  finalize: 'finalise',
  finalized: 'finalised',
  flavor: 'flavour',
  flavors: 'flavours',
  fulfill: 'fulfil',
  fulfillment: 'fulfilment',
  generalize: 'generalise',
  generalizable: 'generalisable',
  generalized: 'generalised',
  gray: 'grey',
  harbor: 'harbour',
  honor: 'honour',
  honored: 'honoured',
  honors: 'honours',
  humor: 'humour',
  initialize: 'initialise',
  initialization: 'initialisation',
  initialized: 'initialised',
  initializing: 'initialising',
  installment: 'instalment',
  judgment: 'judgement',
  labeled: 'labelled',
  labeling: 'labelling',
  labor: 'labour',
  liter: 'litre',
  localize: 'localise',
  localized: 'localised',
  maneuver: 'manoeuvre',
  maximize: 'maximise',
  maximized: 'maximised',
  meter: 'metre',
  minimize: 'minimise',
  minimized: 'minimised',
  modeled: 'modelled',
  modeling: 'modelling',
  modernize: 'modernise',
  monetize: 'monetise',
  neighbor: 'neighbour',
  neighborhood: 'neighbourhood',
  neighbors: 'neighbours',
  normalize: 'normalise',
  normalized: 'normalised',
  offense: 'offence',
  optimize: 'optimise',
  optimization: 'optimisation',
  optimized: 'optimised',
  optimizing: 'optimising',
  organize: 'organise',
  organization: 'organisation',
  organizations: 'organisations',
  organized: 'organised',
  organizing: 'organising',
  parlor: 'parlour',
  pediatric: 'paediatric',
  personalize: 'personalise',
  personalized: 'personalised',
  pretense: 'pretence',
  prioritize: 'prioritise',
  prioritized: 'prioritised',
  realize: 'realise',
  realized: 'realised',
  realizing: 'realising',
  recognize: 'recognise',
  recognized: 'recognised',
  recognizing: 'recognising',
  rumor: 'rumour',
  sanitize: 'sanitise',
  sanitized: 'sanitised',
  serialize: 'serialise',
  serialized: 'serialised',
  skeptic: 'sceptic',
  skeptical: 'sceptical',
  skillful: 'skilful',
  specialize: 'specialise',
  specialized: 'specialised',
  specialty: 'speciality',
  splendor: 'splendour',
  standardize: 'standardise',
  standardized: 'standardised',
  summarize: 'summarise',
  summarized: 'summarised',
  synchronize: 'synchronise',
  synchronized: 'synchronised',
  theater: 'theatre',
  traveled: 'travelled',
  traveler: 'traveller',
  traveling: 'travelling',
  utilize: 'utilise',
  utilized: 'utilised',
  vapor: 'vapour',
  vigor: 'vigour',
  visualize: 'visualise',
  visualized: 'visualised',
  willful: 'wilful'
};

const COMMONWEALTH_TO_US: Record<string, string> = {};
for (const [us, cw] of Object.entries(US_TO_COMMONWEALTH)) {
  COMMONWEALTH_TO_US[cw] = us;
}

function matchCasing(source: string, replacement: string): string {
  if (source.length > 1 && source === source.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (source[0] && source[0] === source[0].toUpperCase() && source.slice(1) === source.slice(1).toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Look up an auto-correction for a single ASCII word given the active language.
 * Returns null if the word should not be changed (or if language is 'off').
 */
export function lookupAutoCorrect(word: string, lang: SpellLanguage): string | null {
  if (lang === 'off' || !word || word.length < 2) return null;
  if (!/^[A-Za-z]+$/.test(word)) return null;
  // Skip mixed camelCase / PascalCase identifiers like `myColor` or `ColorMap`.
  const isAllLower = word === word.toLowerCase();
  const isAllUpper = word === word.toUpperCase();
  const isTitleCase =
    word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
  if (!isAllLower && !isAllUpper && !isTitleCase) return null;

  const lower = word.toLowerCase();
  let replacement = COMMON_TYPOS[lower];

  if (!replacement) {
    if (lang === 'en-AU' || lang === 'en-GB') {
      replacement = US_TO_COMMONWEALTH[lower];
    } else if (lang === 'en-US') {
      replacement = COMMONWEALTH_TO_US[lower];
    }
  }

  if (!replacement) return null;
  const cased = matchCasing(word, replacement);
  return cased === word ? null : cased;
}

export function isWordBoundaryChar(ch: string): boolean {
  return /^[\s.,;:!?)\]}]$/.test(ch);
}

/**
 * Determine if the caret position inside raw Markdown is inside frontmatter,
 * a fenced code block, inline code backticks, or a Markdown link target `](...)`.
 */
export function isRawMarkdownProtectedPos(text: string, caret: number): boolean {
  const before = text.slice(0, caret);

  // 1. Inside YAML frontmatter at top of document
  if (before.startsWith('---\n') || before.startsWith('---\r\n')) {
    const rest = before.slice(4);
    if (!/\r?\n---(?:\r?\n|$)/.test(rest)) {
      return true;
    }
  }

  // 2. Inside fenced code block (``` or ~~~)
  const fenceMatches = before.match(/^[ \t]*(?:```|~~~)/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    return true;
  }

  // 3. Inside inline code span on the current line
  const lineStart = before.lastIndexOf('\n') + 1;
  const currentLine = before.slice(lineStart);
  const backticks = currentLine.match(/`/g);
  if (backticks && backticks.length % 2 === 1) {
    return true;
  }

  // 4. Inside a Markdown link target `](...)` or raw URL on the current line
  const lastLinkOpen = currentLine.lastIndexOf('](');
  if (lastLinkOpen >= 0 && currentLine.indexOf(')', lastLinkOpen) === -1) {
    return true;
  }

  return false;
}

/**
 * Find the word immediately before `caret` (assuming `text.slice(0, caret)` ends with a word).
 * Returns null if the word is part of a path, URL, or identifier (preceded by `/`, `_`, `@`, `#`, `:`).
 */
export function extractWordBeforeCaret(text: string, caret: number): { word: string; start: number; end: number } | null {
  const before = text.slice(0, caret);
  const match = before.match(/([A-Za-z]{2,})$/);
  if (!match) return null;
  const word = match[1];
  const start = caret - word.length;
  if (start > 0) {
    const prev = before[start - 1];
    if (/[\/\\_@#:$`.0-9-]/.test(prev)) {
      return null;
    }
  }
  return { word, start, end: caret };
}
