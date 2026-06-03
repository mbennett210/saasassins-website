import Badge from './Badge';

const CHANNEL_VARIANTS = {
  sms:      'green',
  email:    'blue',
  internal: 'purple',
  dm:       'blue',
};

const CHANNEL_LABELS = {
  sms:      'SMS',
  email:    'Email',
  internal: 'Internal',
  dm:       'DM',
};

export default function ChannelBadge({ channel, label }) {
  const variant = CHANNEL_VARIANTS[channel] || 'slate';
  const text = label || CHANNEL_LABELS[channel] || channel;
  return <Badge variant={variant}>{text}</Badge>;
}
