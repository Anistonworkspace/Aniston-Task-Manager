const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Note = sequelize.define('Note', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  title: { type: DataTypes.STRING(300), allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  duration: { type: DataTypes.INTEGER, defaultValue: 0 },
  type: { type: DataTypes.STRING(20), defaultValue: 'voice_note' },
  lang: { type: DataTypes.STRING(10), defaultValue: 'en-US' },
  userId: { type: DataTypes.UUID, allowNull: false },
}, { tableName: 'notes', timestamps: true });

module.exports = Note;
