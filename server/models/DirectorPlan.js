const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const DEFAULT_CATEGORIES = [
  { id: 'tender-ongoing', label: 'Tender Ongoing Works', icon: 'Hammer', color: '#E8590C', startTime: '09:00', endTime: '10:30', tasks: [] },
  { id: 'tender-billing', label: 'Tender Billing', icon: 'Receipt', color: '#D6336C', startTime: '10:30', endTime: '11:30', tasks: [] },
  { id: 'material-purchase', label: 'Material Purchase', icon: 'Package', color: '#9333EA', startTime: '11:30', endTime: '12:30', tasks: [] },
  { id: 'new-tenders', label: 'New Tenders to Put', icon: 'ClipboardList', color: '#4F46E5', startTime: '12:30', endTime: '13:30', tasks: [] },
  { id: 'accounts-legal', label: 'Accounts & Legal / Certification', icon: 'Scale', color: '#2563EB', startTime: '14:00', endTime: '15:00', tasks: [] },
  { id: 'research', label: 'Aniston Research Work', icon: 'FlaskConical', color: '#059669', startTime: '15:00', endTime: '16:00', tasks: [] },
  { id: 'assembly-unit', label: 'New Assembly Unit', icon: 'Factory', color: '#D97706', startTime: '16:00', endTime: '16:30', tasks: [] },
  { id: 'ai-models', label: 'AI Models', icon: 'Bot', color: '#DC2626', startTime: '16:30', endTime: '17:00', tasks: [] },
  { id: 'software', label: 'Software Products', icon: 'Monitor', color: '#0D9488', startTime: '17:00', endTime: '17:30', tasks: [] },
  { id: 'graphics', label: 'Graphic, Print & Packaging', icon: 'Palette', color: '#7C3AED', startTime: '17:30', endTime: '18:00', tasks: [] },
];

const DirectorPlan = sequelize.define('DirectorPlan', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  directorId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  categories: {
    type: DataTypes.JSONB,
    defaultValue: DEFAULT_CATEGORIES,
  },
  notes: {
    type: DataTypes.TEXT,
    defaultValue: '',
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'director_plans',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['date', 'directorId'] },
  ],
});

DirectorPlan.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;

module.exports = DirectorPlan;
