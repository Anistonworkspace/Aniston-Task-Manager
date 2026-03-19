/**
 * Pre-built Workspace Templates for Aniston Project Hub
 * Each template includes boards with groups and columns pre-configured
 */

export const WORKSPACE_TEMPLATES = [
  {
    id: 'campaign_management',
    name: 'Campaign Management',
    description: 'Plan and deliver winning campaigns',
    icon: 'Megaphone',
    color: '#e2445c',
    category: 'Marketing',
    boards: [
      {
        name: 'Campaign Pipeline',
        color: '#e2445c',
        groups: [
          { id: 'planning', title: 'Planning', color: '#579bfc', position: 0 },
          { id: 'in_progress', title: 'In Progress', color: '#fdab3d', position: 1 },
          { id: 'launched', title: 'Launched', color: '#00c875', position: 2 },
          { id: 'completed', title: 'Completed', color: '#9cd326', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Owner', type: 'person', width: 140 },
          { id: 'date', title: 'Launch Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Content Calendar',
        color: '#ff642e',
        groups: [
          { id: 'draft', title: 'Draft', color: '#579bfc', position: 0 },
          { id: 'review', title: 'In Review', color: '#fdab3d', position: 1 },
          { id: 'approved', title: 'Approved', color: '#00c875', position: 2 },
          { id: 'published', title: 'Published', color: '#9cd326', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Creator', type: 'person', width: 140 },
          { id: 'date', title: 'Publish Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'event_management',
    name: 'Event Management',
    description: 'Organize events from start to finish',
    icon: 'Calendar',
    color: '#a25ddc',
    category: 'Operations',
    boards: [
      {
        name: 'Event Planning',
        color: '#a25ddc',
        groups: [
          { id: 'pre_event', title: 'Pre-Event', color: '#579bfc', position: 0 },
          { id: 'logistics', title: 'Logistics', color: '#fdab3d', position: 1 },
          { id: 'day_of', title: 'Day-of Tasks', color: '#e2445c', position: 2 },
          { id: 'post_event', title: 'Post-Event', color: '#00c875', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Responsible', type: 'person', width: 140 },
          { id: 'date', title: 'Deadline', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Vendor & Budget Tracker',
        color: '#00c875',
        groups: [
          { id: 'vendors', title: 'Vendors', color: '#579bfc', position: 0 },
          { id: 'budget', title: 'Budget Items', color: '#fdab3d', position: 1 },
          { id: 'contracts', title: 'Contracts', color: '#e2445c', position: 2 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Contact', type: 'person', width: 140 },
          { id: 'date', title: 'Due Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'engineering',
    name: 'Engineering & Development',
    description: 'Track sprints, bugs, and releases',
    icon: 'Code',
    color: '#0073ea',
    category: 'Engineering',
    boards: [
      {
        name: 'Sprint Board',
        color: '#0073ea',
        groups: [
          { id: 'backlog', title: 'Backlog', color: '#c4c4c4', position: 0 },
          { id: 'sprint', title: 'Current Sprint', color: '#579bfc', position: 1 },
          { id: 'in_dev', title: 'In Development', color: '#fdab3d', position: 2 },
          { id: 'testing', title: 'Testing', color: '#a25ddc', position: 3 },
          { id: 'done', title: 'Done', color: '#00c875', position: 4 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Developer', type: 'person', width: 140 },
          { id: 'date', title: 'Due Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Bug Tracker',
        color: '#e2445c',
        groups: [
          { id: 'reported', title: 'Reported', color: '#e2445c', position: 0 },
          { id: 'investigating', title: 'Investigating', color: '#fdab3d', position: 1 },
          { id: 'fixing', title: 'Fixing', color: '#579bfc', position: 2 },
          { id: 'resolved', title: 'Resolved', color: '#00c875', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Assigned To', type: 'person', width: 140 },
          { id: 'date', title: 'Target Fix', type: 'date', width: 140 },
          { id: 'priority', title: 'Severity', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'product_roadmap',
    name: 'Product Roadmap',
    description: 'Plan features and track product vision',
    icon: 'Map',
    color: '#ff642e',
    category: 'Product',
    boards: [
      {
        name: 'Product Roadmap',
        color: '#ff642e',
        groups: [
          { id: 'now', title: 'Now (This Quarter)', color: '#00c875', position: 0 },
          { id: 'next', title: 'Next (Next Quarter)', color: '#579bfc', position: 1 },
          { id: 'later', title: 'Later (Future)', color: '#c4c4c4', position: 2 },
          { id: 'ideas', title: 'Ideas Backlog', color: '#fdab3d', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Product Owner', type: 'person', width: 140 },
          { id: 'date', title: 'Target Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Impact', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'inventory_management',
    name: 'Inventory Management',
    description: 'Track stock, orders, and supplies',
    icon: 'Package',
    color: '#00c875',
    category: 'Operations',
    boards: [
      {
        name: 'Inventory Tracker',
        color: '#00c875',
        groups: [
          { id: 'in_stock', title: 'In Stock', color: '#00c875', position: 0 },
          { id: 'low_stock', title: 'Low Stock', color: '#fdab3d', position: 1 },
          { id: 'out_of_stock', title: 'Out of Stock', color: '#e2445c', position: 2 },
          { id: 'ordered', title: 'Ordered', color: '#579bfc', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Manager', type: 'person', width: 140 },
          { id: 'date', title: 'Reorder Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Urgency', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Purchase Orders',
        color: '#579bfc',
        groups: [
          { id: 'pending', title: 'Pending Approval', color: '#fdab3d', position: 0 },
          { id: 'approved', title: 'Approved', color: '#00c875', position: 1 },
          { id: 'shipped', title: 'Shipped', color: '#579bfc', position: 2 },
          { id: 'received', title: 'Received', color: '#9cd326', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Ordered By', type: 'person', width: 140 },
          { id: 'date', title: 'Expected Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'sales_crm',
    name: 'Sales CRM Pipeline',
    description: 'Manage leads, deals, and client relationships',
    icon: 'TrendingUp',
    color: '#579bfc',
    category: 'Sales',
    boards: [
      {
        name: 'Sales Pipeline',
        color: '#579bfc',
        groups: [
          { id: 'lead', title: 'New Leads', color: '#c4c4c4', position: 0 },
          { id: 'contacted', title: 'Contacted', color: '#579bfc', position: 1 },
          { id: 'proposal', title: 'Proposal Sent', color: '#fdab3d', position: 2 },
          { id: 'negotiation', title: 'Negotiation', color: '#a25ddc', position: 3 },
          { id: 'closed_won', title: 'Closed Won', color: '#00c875', position: 4 },
          { id: 'closed_lost', title: 'Closed Lost', color: '#e2445c', position: 5 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Sales Rep', type: 'person', width: 140 },
          { id: 'date', title: 'Close Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Deal Size', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Client Management',
        color: '#00c875',
        groups: [
          { id: 'active', title: 'Active Clients', color: '#00c875', position: 0 },
          { id: 'onboarding', title: 'Onboarding', color: '#579bfc', position: 1 },
          { id: 'at_risk', title: 'At Risk', color: '#e2445c', position: 2 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Account Manager', type: 'person', width: 140 },
          { id: 'date', title: 'Next Review', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'hr_onboarding',
    name: 'HR & Onboarding',
    description: 'Streamline hiring and employee onboarding',
    icon: 'UserPlus',
    color: '#9cd326',
    category: 'HR',
    boards: [
      {
        name: 'Recruitment Pipeline',
        color: '#9cd326',
        groups: [
          { id: 'sourcing', title: 'Sourcing', color: '#c4c4c4', position: 0 },
          { id: 'screening', title: 'Screening', color: '#579bfc', position: 1 },
          { id: 'interview', title: 'Interview', color: '#fdab3d', position: 2 },
          { id: 'offer', title: 'Offer Sent', color: '#a25ddc', position: 3 },
          { id: 'hired', title: 'Hired', color: '#00c875', position: 4 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Recruiter', type: 'person', width: 140 },
          { id: 'date', title: 'Start Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Onboarding Checklist',
        color: '#00c875',
        groups: [
          { id: 'day1', title: 'Day 1', color: '#e2445c', position: 0 },
          { id: 'week1', title: 'Week 1', color: '#fdab3d', position: 1 },
          { id: 'month1', title: 'Month 1', color: '#579bfc', position: 2 },
          { id: 'ongoing', title: 'Ongoing', color: '#00c875', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Assigned To', type: 'person', width: 140 },
          { id: 'date', title: 'Due Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'goals_okr',
    name: 'Goals & OKR Tracker',
    description: 'Set team goals, achieve together',
    icon: 'Target',
    color: '#fdab3d',
    category: 'Strategy',
    boards: [
      {
        name: 'OKR Dashboard',
        color: '#fdab3d',
        groups: [
          { id: 'company', title: 'Company Goals', color: '#e2445c', position: 0 },
          { id: 'team', title: 'Team Goals', color: '#579bfc', position: 1 },
          { id: 'individual', title: 'Individual Goals', color: '#00c875', position: 2 },
        ],
        columns: [
          { id: 'status', title: 'Progress', type: 'status', width: 140 },
          { id: 'person', title: 'Owner', type: 'person', width: 140 },
          { id: 'date', title: 'Target Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Impact', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'project_tracker',
    name: 'Project Tracker',
    description: 'Manage projects start to finish',
    icon: 'FolderKanban',
    color: '#0073ea',
    category: 'General',
    boards: [
      {
        name: 'Projects',
        color: '#0073ea',
        groups: [
          { id: 'not_started', title: 'Not Started', color: '#c4c4c4', position: 0 },
          { id: 'in_progress', title: 'In Progress', color: '#fdab3d', position: 1 },
          { id: 'review', title: 'Review', color: '#a25ddc', position: 2 },
          { id: 'done', title: 'Done', color: '#00c875', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Owner', type: 'person', width: 140 },
          { id: 'date', title: 'Deadline', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'meeting_notes',
    name: 'Meeting Notes & Actions',
    description: 'Turn meetings into action items',
    icon: 'FileText',
    color: '#ff158a',
    category: 'General',
    boards: [
      {
        name: 'Meeting Actions',
        color: '#ff158a',
        groups: [
          { id: 'standup', title: 'Standup', color: '#579bfc', position: 0 },
          { id: 'planning', title: 'Planning', color: '#fdab3d', position: 1 },
          { id: 'review', title: 'Review', color: '#a25ddc', position: 2 },
          { id: 'one_on_one', title: '1:1s', color: '#00c875', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Assigned', type: 'person', width: 140 },
          { id: 'date', title: 'Due Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'director_schedule',
    name: 'Director\'s Schedule',
    description: 'Executive daily planner with workspace overview',
    icon: 'Crown',
    color: '#333333',
    category: 'Executive',
    boards: [
      {
        name: 'Strategic Initiatives',
        color: '#333333',
        groups: [
          { id: 'q1', title: 'Q1 Priorities', color: '#0073ea', position: 0 },
          { id: 'q2', title: 'Q2 Priorities', color: '#00c875', position: 1 },
          { id: 'ongoing', title: 'Ongoing', color: '#fdab3d', position: 2 },
          { id: 'blocked', title: 'Blocked', color: '#e2445c', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Lead', type: 'person', width: 140 },
          { id: 'date', title: 'Target', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
      {
        name: 'Executive Reviews',
        color: '#a25ddc',
        groups: [
          { id: 'pending', title: 'Pending Review', color: '#fdab3d', position: 0 },
          { id: 'reviewed', title: 'Reviewed', color: '#00c875', position: 1 },
          { id: 'action_needed', title: 'Action Needed', color: '#e2445c', position: 2 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Owner', type: 'person', width: 140 },
          { id: 'date', title: 'Review Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Urgency', type: 'priority', width: 140 },
        ],
      },
    ],
  },
  {
    id: 'brainstorm',
    name: 'Brainstorm Session',
    description: 'Spark new ideas together',
    icon: 'Lightbulb',
    color: '#fdab3d',
    category: 'Creative',
    boards: [
      {
        name: 'Ideas Board',
        color: '#fdab3d',
        groups: [
          { id: 'ideas', title: 'New Ideas', color: '#fdab3d', position: 0 },
          { id: 'evaluating', title: 'Evaluating', color: '#579bfc', position: 1 },
          { id: 'approved', title: 'Approved', color: '#00c875', position: 2 },
          { id: 'parked', title: 'Parked', color: '#c4c4c4', position: 3 },
        ],
        columns: [
          { id: 'status', title: 'Status', type: 'status', width: 140 },
          { id: 'person', title: 'Submitted By', type: 'person', width: 140 },
          { id: 'date', title: 'Date', type: 'date', width: 140 },
          { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
        ],
      },
    ],
  },
];

export const TEMPLATE_CATEGORIES = [
  { id: 'all', label: 'All Templates' },
  { id: 'General', label: 'General' },
  { id: 'Marketing', label: 'Marketing' },
  { id: 'Sales', label: 'Sales' },
  { id: 'Engineering', label: 'Engineering' },
  { id: 'Product', label: 'Product' },
  { id: 'Operations', label: 'Operations' },
  { id: 'HR', label: 'HR' },
  { id: 'Strategy', label: 'Strategy' },
  { id: 'Executive', label: 'Executive' },
  { id: 'Creative', label: 'Creative' },
];
