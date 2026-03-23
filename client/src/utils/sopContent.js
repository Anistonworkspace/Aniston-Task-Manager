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
// ─── GUIDED SPOTLIGHT TOUR STEPS ────────────────────────────
// Each step has a `target` CSS selector pointing to a real UI element.
// The OnboardingTour component highlights that element and shows the tooltip next to it.
export const TOUR_STEPS = {
  common: [
    {
      icon: '🎉',
      title: 'Welcome to Monday Aniston!',
      description: 'Let us give you a quick tour of the platform. We\'ll highlight each feature so you know exactly where everything is.',
      target: '[data-tour="sidebar"]',
    },
    {
      icon: '🏠',
      title: 'Home',
      description: 'Your home dashboard shows task overview, stat cards, recent boards, and notifications at a glance.',
      target: '[data-tour="nav-home"]',
    },
    {
      icon: '📋',
      title: 'My Work',
      description: 'All tasks assigned to you in one place — grouped by Overdue, Due Today, This Week, and Upcoming.',
      target: '[data-tour="nav-mywork"]',
    },
    {
      icon: '⏰',
      title: 'Time Plan',
      description: 'Plan your daily schedule with time blocks. Set start/end times and link blocks to tasks.',
      target: '[data-tour="nav-timeplan"]',
    },
    {
      icon: '📅',
      title: 'Meetings',
      description: 'View meetings you\'re invited to. Accept or decline invitations and track your schedule.',
      target: '[data-tour="nav-meetings"]',
    },
    {
      icon: '📊',
      title: 'Reviews',
      description: 'Weekly review reports — see your task summary and download PDF/CSV exports.',
      target: '[data-tour="nav-reviews"]',
    },
    {
      icon: '🔍',
      title: 'Quick Search',
      description: 'Press Ctrl+K (or ⌘K) to instantly search across all tasks and boards.',
      target: '[data-tour="search-bar"]',
    },
    {
      icon: '🔔',
      title: 'Notifications',
      description: 'Real-time alerts when tasks are assigned, updated, or when someone mentions you.',
      target: '[data-tour="notifications"]',
    },
    {
      icon: '🌙',
      title: 'Dark Mode',
      description: 'Switch between light and dark theme anytime with this toggle.',
      target: '[data-tour="theme-toggle"]',
    },
    {
      icon: '👤',
      title: 'Your Profile',
      description: 'Click here to update your profile, change password (default: Welcome@1234), and upload your avatar.',
      target: '[data-tour="profile-menu"]',
    },
  ],
  member: [
    {
      icon: '✅',
      title: 'Tasks',
      description: 'View all your assigned tasks here. Click any task to update status, add comments, upload files, or write work logs.',
      target: '[data-tour="nav-tasks"]',
    },
    {
      icon: '📖',
      title: 'Help & SOP',
      description: 'Step-by-step guides for your role — how to update tasks, write daily logs, plan your time, and more.',
      target: '[data-tour="nav-helpsop"]',
    },
  ],
  manager: [
    {
      icon: '📈',
      title: 'Team Dashboard',
      description: 'View your team\'s performance analytics — task completion, workload distribution, overdue tasks, and trends.',
      target: '[data-tour="nav-dashboard"]',
    },
    {
      icon: '➕',
      title: 'Quick Create',
      description: 'Click here to create new boards. Choose from templates like Software Sprint, Marketing Campaign, or start blank.',
      target: '[data-tour="quick-create"]',
    },
    {
      icon: '📂',
      title: 'Workspaces',
      description: 'Your boards are organized in workspaces. Create boards, assign tasks, and manage your team\'s projects.',
      target: '[data-tour="workspaces"]',
    },
  ],
  assistant_manager: [
    {
      icon: '📈',
      title: 'Team Dashboard',
      description: 'View team performance, task trends, and workload analytics.',
      target: '[data-tour="nav-dashboard"]',
    },
    {
      icon: '👑',
      title: 'Director Dashboard',
      description: 'Manage the director\'s schedule, view their time plans, and track their daily tasks.',
      target: '[data-tour="nav-director-dashboard"]',
    },
    {
      icon: '➕',
      title: 'Quick Create',
      description: 'Create boards and organize your team\'s projects quickly.',
      target: '[data-tour="quick-create"]',
    },
  ],
  admin: [
    {
      icon: '📈',
      title: 'Company Dashboard',
      description: 'Organization-wide analytics — team workload, completion trends, SLA monitoring, and more.',
      target: '[data-tour="nav-dashboard"]',
    },
    {
      icon: '🛡️',
      title: 'Admin Settings',
      description: 'Create users, change roles, reset passwords, manage departments, and control system access.',
      target: '[data-tour="nav-admin-settings"]',
    },
    {
      icon: '➕',
      title: 'Quick Create',
      description: 'Create boards and assign tasks to any employee in the organization.',
      target: '[data-tour="quick-create"]',
    },
    {
      icon: '📂',
      title: 'Workspaces & Boards',
      description: 'Organize all company boards into workspaces. Full control over board settings, members, and permissions.',
      target: '[data-tour="workspaces"]',
    },
  ],
};
