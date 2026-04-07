const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const FileAttachment = sequelize.define(
  'FileAttachment',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    filename: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'Generated filename stored on disk / S3',
    },
    originalName: {
      type: DataTypes.STRING(500),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Original file name is required' },
      },
    },
    mimetype: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'File size in bytes',
    },
    url: {
      type: DataTypes.STRING(1000),
      allowNull: false,
      comment: 'Relative or absolute URL to access the file',
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'tasks',
        key: 'id',
      },
    },
    uploadedBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    tableName: 'file_attachments',
    timestamps: true,
    indexes: [
      { fields: ['taskId'] },
      { fields: ['uploadedBy'] },
    ],
  }
);

module.exports = FileAttachment;
