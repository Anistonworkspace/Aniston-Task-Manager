const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * PushSubscription — DB-backed VAPID web-push subscription, per (user, device).
 *
 * Replaces the previous in-memory Map in services/pushService.js so subscriptions
 * survive backend restart and are not split across replicas. Endpoint is the
 * canonical device identity (browser+profile+VAPID public key combo).
 *
 * Lifecycle:
 *   - Created on POST /api/push/subscribe with isActive=true.
 *   - Set isActive=false on POST /api/push/unsubscribe (logout) so the same
 *     browser can re-activate on next login without losing the row.
 *   - Hard-deleted by pushService when web-push returns 404/410 (gone).
 */
const PushSubscription = sequelize.define(
  'PushSubscription',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    endpoint: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    p256dh: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    auth: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    userAgent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    deviceId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastSeenAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deactivatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'push_subscriptions',
    timestamps: true,
    indexes: [
      // Endpoint is globally unique — same browser+VAPID combo always maps
      // to the same row regardless of which user logs in on it. We re-link
      // the row to the new userId on (re)subscribe.
      { unique: true, fields: ['endpoint'] },
      { fields: ['userId'] },
      { fields: ['userId', 'isActive'] },
    ],
  }
);

module.exports = PushSubscription;
