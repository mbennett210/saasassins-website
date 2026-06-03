// Sample data for the PolishPoint app prototype.
// Generic service business; no client-specific branding.

export const COMPANY = {
  name: 'Acme Cleaning Co.',
  owner: 'Alex',
  logoInitials: 'AC',
  invoicePrefix: 'INV',
};

export const SERVICES = [
  'Janitorial',
  'Floor Care',
  'Window Cleaning',
  'Post-Construction',
  'Pressure Washing',
  'Restroom Sanitation',
];

export const FREQUENCIES = ['Weekly', 'Bi-Weekly', 'Monthly', 'Quarterly', 'As-Needed'];

export const TEAM = [
  { id: 't1', name: 'Alex M.', role: 'Owner', initials: 'AM', avatar: 1, status: 'Available' },
  { id: 't2', name: 'Jordan T.', role: 'Lead', initials: 'JT', avatar: 2, status: 'On Site' },
  { id: 't3', name: 'Sam L.', role: 'Technician', initials: 'SL', avatar: 3, status: 'On Site' },
  { id: 't4', name: 'Riley D.', role: 'Technician', initials: 'RD', avatar: 4, status: 'Off Duty' },
  { id: 't5', name: 'Casey S.', role: 'Technician', initials: 'CS', avatar: 5, status: 'Available' },
];

export const CLIENTS = [
  { id: 'c1', name: 'Metro Medical Center',   service: 'Janitorial',         frequency: 'Weekly',     lastService: 'Apr 14', revenue: 4800, status: 'Active'   },
  { id: 'c2', name: 'Lakeside Office Park',   service: 'Floor Care',         frequency: 'Monthly',    lastService: 'Apr 10', revenue: 2200, status: 'Active'   },
  { id: 'c3', name: 'Summit Warehouse',       service: 'Pressure Washing',   frequency: 'Quarterly',  lastService: 'Mar 28', revenue: 1500, status: 'Active'   },
  { id: 'c4', name: 'Greenfield HOA',         service: 'Window Cleaning',    frequency: 'Monthly',    lastService: 'Apr 05', revenue: 1100, status: 'Active'   },
  { id: 'c5', name: 'Pacific Ridge Corp',     service: 'Janitorial',         frequency: 'Bi-Weekly',  lastService: 'Apr 12', revenue: 3400, status: 'Active'   },
  { id: 'c6', name: 'Riverside Senior Living',service: 'Restroom Sanitation',frequency: 'Weekly',     lastService: 'Apr 15', revenue: 2800, status: 'Active'   },
  { id: 'c7', name: 'Downtown Tech Hub',      service: 'Post-Construction',  frequency: 'As-Needed',  lastService: 'Mar 18', revenue:  950, status: 'Inactive' },
];

export const INVOICES = [
  { id: 'INV-1001', client: 'Metro Medical Center',    amount: 1200, date: 'Apr 15', status: 'Paid'    },
  { id: 'INV-1002', client: 'Lakeside Office Park',    amount:  550, date: 'Apr 14', status: 'Paid'    },
  { id: 'INV-1003', client: 'Pacific Ridge Corp',      amount:  850, date: 'Apr 12', status: 'Pending' },
  { id: 'INV-1004', client: 'Riverside Senior Living', amount:  700, date: 'Apr 10', status: 'Pending' },
  { id: 'INV-1005', client: 'Greenfield HOA',          amount:  275, date: 'Apr 08', status: 'Paid'    },
  { id: 'INV-1006', client: 'Summit Warehouse',        amount: 1500, date: 'Mar 28', status: 'Overdue' },
  { id: 'INV-1007', client: 'Downtown Tech Hub',       amount:  950, date: 'Mar 18', status: 'Overdue' },
  { id: 'INV-1008', client: 'Metro Medical Center',    amount: 1200, date: 'Apr 01', status: 'Paid'    },
];

export const TODAY_SCHEDULE = [
  {
    id: 'j1', time: '8:00 AM – 9:30 AM',
    client: 'Metro Medical Center', service: 'Janitorial',
    team: 'Jordan T.', address: '500 Medical Dr', state: 'done',
  },
  {
    id: 'j2', time: '10:00 AM – 12:00 PM',
    client: 'Lakeside Office Park', service: 'Floor Care',
    team: 'Sam L.', address: '200 Lakeside Blvd', state: 'active',
  },
  {
    id: 'j3', time: '1:00 PM – 3:00 PM',
    client: 'Pacific Ridge Corp', service: 'Janitorial',
    team: 'Casey S.', address: '88 Pacific Way', state: 'upcoming',
  },
  {
    id: 'j4', time: '3:30 PM – 5:00 PM',
    client: 'Riverside Senior Living', service: 'Restroom Sanitation',
    team: 'Jordan T.', address: '15 Riverside Ct', state: 'upcoming',
  },
];

export const CONVERSATIONS = [
  {
    id: 'conv1', client: 'Metro Medical Center', initials: 'MM', avatar: 1,
    channel: 'SMS', lastTime: '5m',
    messages: [
      { id: 'm1', direction: 'incoming', text: 'Hey, confirming the 8am cleaning tomorrow.',   time: '2:42 PM' },
      { id: 'm2', direction: 'outgoing', text: 'Confirmed! Jordan will arrive by 7:55 AM.',     time: '2:44 PM' },
      { id: 'm3', direction: 'incoming', text: 'Perfect, thanks.',                              time: '2:45 PM' },
    ],
  },
  {
    id: 'conv2', client: 'Lakeside Office Park', initials: 'LO', avatar: 2,
    channel: 'Email', lastTime: '1h',
    messages: [
      { id: 'm1', direction: 'incoming', text: 'Can we reschedule Thursday to Friday?',         time: '1:15 PM' },
      { id: 'm2', direction: 'outgoing', text: 'Yes, we can move it to Friday 10 AM. Works?',   time: '1:20 PM' },
    ],
  },
  {
    id: 'conv3', client: 'Greenfield HOA', initials: 'GH', avatar: 3,
    channel: 'SMS', lastTime: '3h',
    messages: [
      { id: 'm1', direction: 'incoming', text: 'Invoice received, paying this week.',           time: '11:02 AM' },
    ],
  },
  {
    id: 'conv4', client: 'Pacific Ridge Corp', initials: 'PR', avatar: 4,
    channel: 'SMS', lastTime: '1d',
    messages: [
      { id: 'm1', direction: 'outgoing', text: 'Reminder: cleaning scheduled for tomorrow 1 PM.', time: 'Yesterday' },
      { id: 'm2', direction: 'incoming', text: 'Got it, thanks!',                                 time: 'Yesterday' },
    ],
  },
];

export const WEEK_REVENUE = [
  { day: 'Mon', height: 50, style: 'soft'    },
  { day: 'Tue', height: 60, style: 'soft'    },
  { day: 'Wed', height: 80, style: 'primary' },
  { day: 'Thu', height: 55, style: 'soft'    },
  { day: 'Fri', height: 90, style: 'primary' },
  { day: 'Sat', height: 30, style: 'soft'    },
  { day: 'Sun', height: 10, style: 'muted'   },
];

export const REMINDER_SETTINGS_DEFAULT = {
  bookingConfirmation: true,
  reminder24h: true,
  dayOfEta: true,
  postService: false,
};

export const REMINDER_STATS = {
  sentThisMonth: 248,
  deliveryRate: 98,
  noShowsPrevented: 14,
};
