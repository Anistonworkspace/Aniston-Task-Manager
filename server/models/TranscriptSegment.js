const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TranscriptSegment = sequelize.define('TranscriptSegment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  noteId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  speakerLabel: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'Speaker 0',
  },
  startMs: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  endMs: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '',
  },
}, {
  tableName: 'transcript_segments',
  timestamps: true,
  indexes: [
    { fields: ['noteId'] },
    { fields: ['noteId', 'startMs'] },
  ],
});

module.exports = TranscriptSegment;
