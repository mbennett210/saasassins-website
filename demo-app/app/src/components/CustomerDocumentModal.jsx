// Upload, replace or edit ONE customer document (client hub redesign, plan 2026-10-08 §3.6) — the
// kit Modal over lib/customerDocumentsApi. Three modes:
//   upload  — a new document: its kind, title, valid-through day, the "Visible to the customer"
//             switch and the file (PDF, JPG or PNG, up to 10 MB);
//   replace — a new file for a document already here (a renewed COI): the file, and the title and
//             day it may come with; the old file is deleted on the server;
//   edit    — the words and the day, no file.
// The file is checked here against the SAME rule the route enforces (lib/customerDocuments), so a
// GIF or a 12 MB scan is refused in words before anything uploads.
//
// LANGUAGES: every word is a catalog line (`custDocs.*`). A title the office leaves blank is saved
// as the kind's English default (a stored record's words stay English, UI_RULES §140; the customer
// hub is English, LANG-8).
import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import Toggle from './Toggle';
import { useT } from '../i18n/react';
import { english } from '../i18n/core';
import { errorText } from '../i18n/errors';
import {
  CUSTOMER_DOCUMENT_KINDS, CUSTOMER_DOCUMENT_MIME, customerDocumentFileRefusal,
} from '../lib/customerDocuments';
import * as api from '../lib/customerDocumentsApi';

// Literal keys (UI_RULES §140: never a key built at run time).
export const DOCUMENT_KIND_KEYS = Object.freeze({ coi: 'custDocs.kind.coi', w9: 'custDocs.kind.w9', other: 'custDocs.kind.other' });
const KIND_LONG_KEYS = { coi: 'custDocs.kindLong.coi', w9: 'custDocs.kindLong.w9', other: 'custDocs.kindLong.other' };
const DEFAULT_TITLE_KEYS = { coi: 'custDocs.defaultTitle.coi', w9: 'custDocs.defaultTitle.w9', other: 'custDocs.defaultTitle.other' };
const REFUSAL_KEYS = {
  'file-type': 'custDocs.error.fileType',
  'file-size': 'custDocs.error.fileSize',
  kind: 'custDocs.error.kind',
  title: 'custDocs.error.title', // i18n-ok: a refusal CODE mapped to its catalog key, not words
  'valid-until': 'custDocs.error.validUntil',
  stale: 'custDocs.error.stale',
  'document-exists': 'custDocs.error.stale',
  'not-found': 'custDocs.error.gone',
};
const TITLE_KEYS = { upload: 'custDocs.modal.uploadTitle', replace: 'custDocs.modal.replaceTitle', edit: 'custDocs.modal.editTitle' };

/**
 * @param open     whether the dialog is showing
 * @param mode     'upload' | 'replace' | 'edit'
 * @param doc      the document being replaced or edited (office shape), else null
 * @param clientId the building a new document is for; null = every customer
 * @param onClose  () => void
 * @param onSaved  (document, mode) => void, after the server saved it
 */
export default function CustomerDocumentModal({ open, mode = 'upload', doc = null, clientId = null, onClose, onSaved }) {
  const t = useT();
  const fileRef = useRef(null);
  const [kind, setKind] = useState('coi');
  const [title, setTitle] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [visible, setVisible] = useState(true);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The new document's id, minted ONCE per opening (THE LAW II.7): a retried Upload after a
  // failed save reuses it, so the upload address and the record name the same document.
  const [newId, setNewId] = useState(null);

  // Fresh every time it opens (the dialog stays mounted between opens — the Link dialog's
  // stuck "Saving…" lesson, test-qbo-link-form).
  useEffect(() => {
    if (!open) return;
    setNewId(api.newDocumentId());
    setKind(doc?.kind || (clientId == null ? 'w9' : 'coi'));
    setTitle(doc?.title || '');
    setValidUntil(doc?.validUntil || '');
    setVisible(doc ? doc.visibleToClient !== false : true);
    setFile(null);
    setError('');
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }, [open, doc, clientId]);

  const needsFile = mode === 'upload' || mode === 'replace';
  const defaultTitle = english(DEFAULT_TITLE_KEYS[kind] || DEFAULT_TITLE_KEYS.other);

  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    setError('');
    if (!f) { setFile(null); return; }
    const refused = customerDocumentFileRefusal({ mimeType: f.type, sizeBytes: f.size });
    if (refused) { setFile(null); e.target.value = ''; setError(t(REFUSAL_KEYS[refused])); return; }
    setFile(f);
  };

  const save = async () => {
    if (needsFile && !file) { setError(t('custDocs.error.noFile')); return; }
    setBusy(true);
    setError('');
    const words = { title: title.trim() || defaultTitle, validUntil: validUntil || null };
    try {
      let saved;
      if (mode === 'upload') {
        saved = await api.uploadCustomerDocument({ id: newId || api.newDocumentId(), clientId, kind, ...words, visibleToClient: visible, file });
      } else if (mode === 'replace') {
        saved = await api.replaceCustomerDocument(doc, { file, ...words });
      } else {
        saved = await api.updateCustomerDocument(doc.id, { kind, ...words, visibleToClient: visible });
      }
      setBusy(false);
      onSaved?.(saved, mode);
    } catch (e) {
      setBusy(false);
      setError(errorText(t, e, 'custDocs.error.save', REFUSAL_KEYS));
    }
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={t(TITLE_KEYS[mode] || TITLE_KEYS.upload)}>
      {mode !== 'replace' && (
        <FormField
          label={t('custDocs.field.kind')}
          name="cdoc-kind"
          as="select"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          options={CUSTOMER_DOCUMENT_KINDS.map((k) => ({ value: k, label: t(KIND_LONG_KEYS[k]) }))}
          disabled={busy}
        />
      )}
      <FormField
        label={t('custDocs.field.title')}
        name="cdoc-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={defaultTitle}
        maxLength={120}
        disabled={busy}
        help={t('custDocs.field.titleHelp')}
      />
      <FormField
        label={t('custDocs.field.validUntil')}
        name="cdoc-valid"
        type="date"
        value={validUntil}
        onChange={(e) => setValidUntil(e.target.value)}
        disabled={busy}
        help={t('custDocs.field.validUntilHelp')}
      />
      {mode !== 'replace' && (
        <div className="pref-row">
          <div className="pref-row-text">
            <div className="pref-row-label">{t('custDocs.visibleLabel')}</div>
            <div className="pref-row-desc">{t('custDocs.field.visibleHelp')}</div>
          </div>
          <Toggle on={visible} onChange={setVisible} disabled={busy} />
        </div>
      )}
      {needsFile && (
        <FormField label={t('custDocs.field.file')} name="cdoc-file" help={t('custDocs.field.fileHelp')}>
          <input
            ref={fileRef}
            id="ff-cdoc-file"
            className="input"
            type="file"
            accept={CUSTOMER_DOCUMENT_MIME.join(',')}
            onChange={pick}
            disabled={busy}
          />
        </FormField>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? t('common.saving') : t(mode === 'edit' ? 'common.save' : 'custDocs.uploadSave')}
        </button>
      </div>
    </Modal>
  );
}
