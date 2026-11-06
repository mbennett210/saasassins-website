// THE APP'S OWN ADDRESS FOR A LINK THAT LEAVES THE BROWSER (UI_RULES §129): a password reset's landing
// page, and a quote's or an inspection report's link the office copies into an email. The server's half,
// for the links it emails itself, is api/_lib/appUrl.js (DEV_PLAYBOOK 3.4.18).
//
// In a deployed build it is the brand pack's appUrl (IDENTITY.appUrl), so a link made while signed in on
// an old alias of the app (Clean Space's cleanspace-gilt.vercel.app still serves it) still sends its reader
// to the app's own address, where their session will live. On a developer's machine (the dev server) and in
// the login-free demo build, the deployed app holds none of this page's records, so it is this page's own
// origin. Named reads of import.meta.env only (CS-398: a whole-object read inlines every VITE_ value).
import { IDENTITY } from '../brand/identity.generated.js';

/** A deployed build: a production build that is not the login-free demo (`build:demo` is PROD too). */
export const isDeployedBuild = ({ PROD, MODE } = {}) => !!PROD && MODE !== 'demo';

const DEPLOYED = typeof import.meta !== 'undefined' && isDeployedBuild({ PROD: import.meta.env?.PROD, MODE: import.meta.env?.MODE });

/** The base a link that leaves the browser starts with, without a trailing slash. */
export function appLinkBase({ deployed = DEPLOYED, origin = (typeof window !== 'undefined' && window.location?.origin) || '' } = {}) {
  return deployed ? IDENTITY.appUrl : origin;
}

/** `path` (starting with "/") on that base. */
export const appLink = (path) => `${appLinkBase()}${path}`;
