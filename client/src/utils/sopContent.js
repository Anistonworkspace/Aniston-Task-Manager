import {
  LogIn, KeyRound, UserCircle, ClipboardList, RefreshCw, FileText, Clock,
  LayoutGrid, UserPlus, BarChart3, Users, Calendar, Crown, Settings,
  Building2, Link2, Archive, Shield, CheckCircle, MessageSquare, Upload,
  ListChecks, CalendarDays, Download, Filter, Search, GripVertical, Eye,
  Bell, GitBranch, Repeat, Zap
} from 'lucide-react';

// ─── MEMBER SOP ─────────────────────────────────────────────
const MEMBER_SECTIONS = [
  {
    title: 'First-Time Login',
    icon: LogIn,
    steps: [
      { title: 'Open the App', description: 'Go to monday.anistonav.com in your browser.' },
      { title: 'Enter Credentials', description: 'Use your email (synced from Microsoft 365) and the default password: Welcome@1234' },
      { title: 'Click Log In', description: 'You will be taken to your Home dashboard.' },
    ],
  },
  {
    title: 'Change Your Password',
    icon: KeyRound,
    steps: [
      { title: 'Open Profile', description: 'Click your name (bottom-left of sidebar) then the gear icon, or click your avatar (top-right) and select Profile.' },
      { title: 'Scroll to Change Password', description: 'Enter your current password (Welcome@1234), then your new password.' },
      { title: 'Password Requirements', description: 'Must be 8+ characters with uppercase, lowercase, number, and special character.' },
      { title: 'Save', description: 'Click "Update Password" to save your new password.' },
    ],
  },
  {
    title: 'Set Up Your Profile',
    icon: UserCircle,
    steps: [
      { title: 'Upload Avatar', description: 'Click the profile circle to choose a photo.' },
      { title: 'Edit Name & Info', description: 'Update your display name, department, and designation.' },
      { title: 'Save Changes', description: 'Click "Save" to update your profile.' },
    ],
  },
  {
    title: 'Check Your Tasks',
    icon: ClipboardList,
    steps: [
      { title: 'Home Page', description: 'Your Home page shows "My Tasks" table with all tasks assigned to you across all boards.' },
      { title: 'My Work Page', description: 'Click "My Work" in sidebar to see tasks grouped by: Overdue, Due Today, This Week, Upcoming, Completed.' },
      { title: 'Calendar View', description: 'Switch to the Calendar tab in My Work to see tasks on a monthly calendar.' },
    ],
  },
  {
    title: 'Update Task Status',
    icon: RefreshCw,
    steps: [
      { title: 'Find Your Task', description: 'Go to Home, My Work, or any Board page.' },
      { title: 'Click the Status Column', description: 'Click the status cell on the task row.' },
      { title: 'Select New Status', description: 'Choose: Not Started, Working on it, In Progress, Stuck, Done, or In Review.' },
      { title: 'Real-Time Update', description: 'Your manager sees the change instantly.' },
    ],
  },
  {
    title: 'Write Daily Work Updates',
    icon: FileText,
    steps: [
      { title: 'Open Task', description: 'Click on any task to open the Task Modal.' },
      { title: 'Go to Work Logs Tab', description: 'Click the "Work Logs" tab in the modal.' },
      { title: 'Add Update', description: 'Click "Add Update", write what you worked on today, and submit.' },
    ],
  },
  {
    title: 'Comments & Files',
    icon: MessageSquare,
    steps: [
      { title: 'Add Comments', description: 'Open task modal > Comments tab. Use @name to mention and notify someone.' },
      { title: 'Upload Files', description: 'Open task modal > Files tab. Drag & drop or click Upload (max 25 MB).' },
    ],
  },
  {
    title: 'Subtasks',
    icon: ListChecks,
    steps: [
      { title: 'Add Subtasks', description: 'Open task modal > see Subtasks section > click "+ Add subtask".' },
      { title: 'Track Progress', description: 'Check/uncheck subtasks as you complete them. Progress bar updates automatically.' },
    ],
  },
  {
    title: 'Time Planner',
    icon: Clock,
    steps: [
      { title: 'Open Time Plan', description: 'Click "Time Plan" in the sidebar.' },
      { title: 'Add Time Blocks', description: 'Click "+ Add" on any day column. Set start time, end time, and description.' },
      { title: 'Link to Tasks', description: 'Optionally link a time block to a specific task.' },
      { title: 'Use Presets', description: 'Quick duration presets: 30min, 1h, 1.5h, 2h, 3h.' },
    ],
  },
  {
    title: 'Meetings',
    icon: Calendar,
    steps: [
      { title: 'View Meetings', description: 'Click "Meetings" in sidebar to see meetings you are invited to.' },
      { title: 'Accept or Decline', description: 'Click Accept or Decline on each meeting invitation.' },
    ],
  },
  {
    title: 'Reviews',
    icon: Download,
    steps: [
      { title: 'Weekly Review', description: 'Click "Reviews" in sidebar to see your weekly task completion stats.' },
      { title: 'Download', description: 'Download your review as PDF or CSV.' },
    ],
  },
];

// ─── MANAGER SOP ────────────────────────────────────────────
const MANAGER_SECTIONS = [
  ...MEMBER_SECTIONS.slice(0, 3), // Login, Password, Profile (same)
  {
    title: 'Create a Board',
    icon: LayoutGrid,
    steps: [
      { title: 'Click "+ New"', description: 'Click the "+ New" button in the top-right header.' },
      { title: 'Choose Template', description: 'Select from: Blank Board, Software Sprint, Marketing Campaign, HR Onboarding, CRM Pipeline, Project Tracker.' },
      { title: 'Name & Color', description: 'Give the board a name and pick a color, then click "Create".' },
    ],
  },
  {
    title: 'Configure Board',
    icon: Settings,
    steps: [
      { title: 'Add Groups', description: 'Click "+ Add Group" at the bottom to create task groups (sprints, phases).' },
      { title: 'Add Columns', description: 'Click "+" at the end of column headers to add: Text, Number, Date, Status, Person, Priority, etc.' },
      { title: 'Board Settings', description: 'Click the gear icon for: General, Columns, Groups, Members, Danger Zone tabs.' },
    ],
  },
  {
    title: 'Create & Assign Tasks',
    icon: UserPlus,
    steps: [
      { title: 'Add Task', description: 'Click "+ Add task" at the bottom of any group, type name, press Enter.' },
      { title: 'Assign Owner', description: 'Click the Owner/Person column > search employee > select. They get notified instantly.' },
      { title: 'Set Details', description: 'Click the task row to set Status, Priority, Due Date, and Description.' },
      { title: 'Bulk Actions', description: 'Select multiple tasks with checkboxes, then use the floating toolbar to change Status/Priority/Assignee.' },
    ],
  },
  {
    title: 'Board Views',
    icon: Eye,
    steps: [
      { title: 'Table View', description: 'Default spreadsheet view with columns.' },
      { title: 'Kanban View', description: 'Drag cards between status columns.' },
      { title: 'Calendar View', description: 'Monthly calendar showing tasks by due date.' },
      { title: 'Gantt/Timeline', description: 'Timeline view with task bars and zoom controls.' },
    ],
  },
  {
    title: 'Dashboard & Analytics',
    icon: BarChart3,
    steps: [
      { title: 'Open Dashboard', description: 'Click "Dashboard" in sidebar.' },
      { title: 'View Stats', description: 'See: Total tasks, completed, overdue, in progress, completion trend charts.' },
      { title: 'Team Overview', description: 'See each member\'s task count and status breakdown.' },
      { title: 'Member Drill-Down', description: 'Click any member to see their detailed task list.' },
    ],
  },
  {
    title: 'Team Management',
    icon: Users,
    steps: [
      { title: 'View Team', description: 'Click "Team" in sidebar to see all team members.' },
      { title: 'Create Users', description: 'Click "+ Create User" to add new members.' },
      { title: 'Reset Password', description: 'Click "..." menu on user row > Reset Password.' },
      { title: 'Team Time Plans', description: 'In Time Plan, switch to "Team" tab to view all members\' schedules.' },
    ],
  },
  {
    title: 'Meetings & Scheduling',
    icon: Calendar,
    steps: [
      { title: 'Create Meeting', description: 'Click Meetings > "+ New Meeting". Set title, date, time, location, participants.' },
      { title: 'Link to Board/Task', description: 'Optionally link the meeting to a specific board or task.' },
      { title: 'Manage', description: 'Edit or cancel meetings. All participants get notified.' },
    ],
  },
  {
    title: 'Filters, Sort & Search',
    icon: Filter,
    steps: [
      { title: 'Filter Tasks', description: 'Click Filter icon on board toolbar. Filter by: Status, Priority, Assignee, Date range.' },
      { title: 'Sort', description: 'Click any column header to sort ascending/descending.' },
      { title: 'Global Search', description: 'Press Ctrl+K anywhere to search tasks and boards.' },
    ],
  },
  {
    title: 'Export & Import',
    icon: Download,
    steps: [
      { title: 'Export CSV', description: 'Board toolbar > Download icon > Export CSV.' },
      { title: 'Import CSV', description: 'Board toolbar > Upload icon > Upload CSV > Map columns > Import.' },
    ],
  },
];

// ─── ASSISTANT MANAGER SOP ──────────────────────────────────
const ASSISTANT_MANAGER_SECTIONS = [
  ...MANAGER_SECTIONS,
  {
    title: 'Director Dashboard',
    icon: Crown,
    steps: [
      { title: 'Access', description: 'Click "Director Dashboard" in sidebar.' },
      { title: 'Manage Schedule', description: 'View and manage the director/CEO\'s schedule and task priorities.' },
      { title: 'Create Plans', description: 'Use "Director Plan" to create weekly plans, schedule meetings, and manage their calendar.' },
    ],
  },
];

// ─── ADMIN SOP ──────────────────────────────────────────────
const ADMIN_SECTIONS = [
  ...MANAGER_SECTIONS,
  {
    title: 'User Management',
    icon: Shield,
    steps: [
      { title: 'Open Admin Settings', description: 'Click "Admin Settings" in sidebar > Users tab.' },
      { title: 'Create User', description: 'Click "+ Create User" > fill Name, Email, Password, Role, Department.' },
      { title: 'Change Role', description: 'Click Role dropdown on any user > select: Member, Assistant Manager, Manager, Admin.' },
      { title: 'Reset Password', description: 'Click "..." > Reset Password > set temporary password.' },
      { title: 'Deactivate/Delete', description: 'Click "..." > Deactivate (can\'t login) or Delete (permanent).' },
    ],
  },
  {
    title: 'Department Management',
    icon: Building2,
    steps: [
      { title: 'Open Departments', description: 'Admin Settings > Departments tab.' },
      { title: 'Create Department', description: 'Click "+ New Department" > set name, color, head.' },
      { title: 'Assign Users', description: 'Users auto-assigned if M365 department matches, or assign manually.' },
    ],
  },
  {
    title: 'Integrations',
    icon: Link2,
    steps: [
      { title: 'Connect Teams', description: 'Click Integrations in sidebar > "Connect Microsoft Teams".' },
      { title: 'Sync Users', description: 'Click "Preview Users" to see M365 employees > "Sync Users Now" to create accounts.' },
      { title: 'Default Password', description: 'All synced users get default password: Welcome@1234.' },
    ],
  },
  {
    title: 'Archive Management',
    icon: Archive,
    steps: [
      { title: 'Open Archive', description: 'Click "Archive" in sidebar.' },
      { title: 'Browse Tabs', description: '5 tabs: Tasks, Boards, Workspaces, Dependencies, Help Requests.' },
      { title: 'Restore Items', description: 'Click "Restore" to bring archived items back.' },
      { title: '90-Day Protection', description: 'Items cannot be permanently deleted for 90 days. Super Admin can bypass this rule.' },
    ],
  },
];

// ─── EXPORT ─────────────────────────────────────────────────
export const SOP_CONTENT = {
  member: {
    title: 'Member Guide',
    subtitle: 'Your complete guide to using Monday Aniston as a team member',
    sections: MEMBER_SECTIONS,
  },
  manager: {
    title: 'Manager Guide',
    subtitle: 'Your complete guide to managing teams and projects',
    sections: MANAGER_SECTIONS,
  },
  assistant_manager: {
    title: 'Assistant Manager Guide',
    subtitle: 'Your complete guide including director management duties',
    sections: ASSISTANT_MANAGER_SECTIONS,
  },
  admin: {
    title: 'Admin Guide',
    subtitle: 'Your complete guide to system administration and management',
    sections: ADMIN_SECTIONS,
  },
};

// ─── ONBOARDING TOUR STEPS ─────────────────────────────────
export const TOUR_STEPS = {
  common: [
    {
      icon: '🎉',
      title: 'Welcome to Monday Aniston!',
      description: 'Your team\'s project management platform. Let us show you around so you can get started quickly.',
    },
    {
      icon: '🔑',
      title: 'Change Your Password',
      description: 'Your default password is Welcome@1234. Go to Profile (click your name at bottom-left) and change it immediately for security.',
      link: '/profile',
      linkText: 'Go to Profile',
    },
    {
      icon: '👤',
      title: 'Set Up Your Profile',
      description: 'Upload your avatar, update your department and designation so your team can identify you easily.',
      link: '/profile',
      linkText: 'Edit Profile',
    },
  ],
  member: [
    {
      icon: '📋',
      title: 'Check My Work',
      description: 'All tasks assigned to you appear in "My Work" — grouped by Overdue, Due Today, This Week, and Upcoming.',
      link: '/my-work',
      linkText: 'Open My Work',
    },
    {
      icon: '🔄',
      title: 'Update Task Status',
      description: 'Click the Status column on any task to change it: Not Started → Working on it → Done. Your manager sees updates in real-time.',
    },
    {
      icon: '📝',
      title: 'Daily Work Logs',
      description: 'Click any task to open it, then go to "Work Logs" tab to write your daily update on what you worked on.',
    },
    {
      icon: '⏰',
      title: 'Plan Your Day',
      description: 'Use "Time Plan" in the sidebar to schedule your daily work blocks with start/end times.',
      link: '/time-plan',
      linkText: 'Open Time Plan',
    },
  ],
  manager: [
    {
      icon: '📊',
      title: 'Create Boards',
      description: 'Click "+ New" in the top-right to create boards. Choose from templates like Software Sprint, Marketing Campaign, or start blank.',
    },
    {
      icon: '👥',
      title: 'Assign Tasks to Your Team',
      description: 'Click the Owner column on any task to assign it to a team member. They\'ll be notified instantly.',
    },
    {
      icon: '📈',
      title: 'Dashboard Analytics',
      description: 'View your team\'s performance, task completion trends, and workload distribution in the Dashboard.',
      link: '/dashboard',
      linkText: 'Open Dashboard',
    },
    {
      icon: '👨‍👩‍👧‍👦',
      title: 'Manage Your Team',
      description: 'Create user accounts, reset passwords, view team schedules, and approve requests in the Team section.',
      link: '/users',
      linkText: 'Open Team',
    },
    {
      icon: '📅',
      title: 'Schedule Meetings',
      description: 'Create meetings with your team, link them to boards or tasks, and track attendance.',
      link: '/meetings',
      linkText: 'Open Meetings',
    },
  ],
  assistant_manager: [
    {
      icon: '📊',
      title: 'Create Boards',
      description: 'Click "+ New" in the top-right to create boards and organize your team\'s projects.',
    },
    {
      icon: '👥',
      title: 'Assign Tasks',
      description: 'Click the Owner column on any task to assign it. Team members get notified instantly.',
    },
    {
      icon: '📈',
      title: 'Dashboard Analytics',
      description: 'View team performance and task trends in the Dashboard.',
      link: '/dashboard',
      linkText: 'Open Dashboard',
    },
    {
      icon: '👑',
      title: 'Director Dashboard',
      description: 'As an Assistant Manager, you can manage the director\'s schedule, create weekly plans, and handle PA duties.',
      link: '/director-dashboard',
      linkText: 'Open Director Dashboard',
    },
    {
      icon: '📅',
      title: 'Director Plan',
      description: 'Create and manage the director\'s weekly plan, schedule meetings, and coordinate their calendar.',
      link: '/director-plan',
      linkText: 'Open Director Plan',
    },
  ],
  admin: [
    {
      icon: '📊',
      title: 'Create Boards & Tasks',
      description: 'Click "+ New" to create boards, add tasks, and assign them to any employee in the organization.',
    },
    {
      icon: '📈',
      title: 'Company Dashboard',
      description: 'View organization-wide analytics, team workload, and completion trends.',
      link: '/dashboard',
      linkText: 'Open Dashboard',
    },
    {
      icon: '🛡️',
      title: 'User Management',
      description: 'Create users, change roles, reset passwords, and manage access in Admin Settings.',
      link: '/admin-settings',
      linkText: 'Open Admin Settings',
    },
    {
      icon: '🏢',
      title: 'Departments',
      description: 'Create and manage departments with colors and heads in Admin Settings > Departments tab.',
      link: '/admin-settings',
      linkText: 'Manage Departments',
    },
    {
      icon: '🔗',
      title: 'Microsoft Teams Integration',
      description: 'Connect Microsoft Teams to sync M365 users, calendars, and notifications.',
      link: '/integrations',
      linkText: 'Open Integrations',
    },
    {
      icon: '🗄️',
      title: 'Archive & Data Protection',
      description: 'Manage archived items with 90-day deletion protection. Super Admin can bypass this rule.',
      link: '/archive',
      linkText: 'Open Archive',
    },
  ],
};
