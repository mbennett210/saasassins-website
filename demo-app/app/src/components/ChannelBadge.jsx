import Badge from './Badge';
import { useT } from '../i18n/react';

const CHANNEL_VARIANTS = {
  sms:      'green',
  email:    'blue',
  internal: 'purple',
  dm:       'blue',
};

// Catalog keys: the badge reads in the reader's language (CS-193).
const CHANNEL_LABEL_KEYS = {
  sms:      'messages.channel.sms',
  email:    'messages.channel.email',
  internal: 'messages.channel.internal',
  dm:       'messages.channel.dm',
};

export default function ChannelBadge({ channel, label }) {
  const t = useT();
  const variant = CHANNEL_VARIANTS[channel] || 'slate';
  const text = label || (CHANNEL_LABEL_KEYS[channel] ? t(CHANNEL_LABEL_KEYS[channel]) : channel);
  return <Badge variant={variant}>{text}</Badge>;
}
