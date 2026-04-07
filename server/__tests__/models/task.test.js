/**
 * Unit tests for the Task model.
 *
 * All database calls are fully mocked — no real DB connection is made.
 * The tests exercise:
 *   - Default field values (status, priority, progress, groupId, etc.)
 *   - JSONB fields default to empty arrays / empty objects
 *   - Numeric validation on the progress field (0–100)
 *   - Title validation (required, length constraints)
 *   - Table name and other structural assertions
 */

'use strict';

// ─── Mock the DB connection before anything else loads ───────────────────────
// We stub sequelize.define() so the model file loads without a real dialect.
jest.mock('../../config/db', () => {
  const sequelize = {
    define: (modelName, attributes, options) => {
      function ModelClass() {}
      ModelClass.rawAttributes = attributes;
      ModelClass.options = options || {};
      ModelClass.tableName = (options && options.tableName) || modelName;
      ModelClass.prototype = {};
      return ModelClass;
    },
  };
  return { sequelize };
});

const Task = require('../../models/Task');

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Task model', () => {

  // ── Default field values ───────────────────────────────────────────────────

  describe('default field values', () => {
    it('defaults status to "not_started"', () => {
      const statusAttr = Task.rawAttributes.status;
      expect(statusAttr.defaultValue).toBe('not_started');
    });

    it('defaults priority to "medium"', () => {
      const priorityAttr = Task.rawAttributes.priority;
      expect(priorityAttr.defaultValue).toBe('medium');
    });

    it('defaults progress to 0', () => {
      const progressAttr = Task.rawAttributes.progress;
      expect(progressAttr.defaultValue).toBe(0);
    });

    it('defaults groupId to "new"', () => {
      const groupAttr = Task.rawAttributes.groupId;
      expect(groupAttr.defaultValue).toBe('new');
    });

    it('defaults position to 0', () => {
      const posAttr = Task.rawAttributes.position;
      expect(posAttr.defaultValue).toBe(0);
    });

    it('defaults isArchived to false', () => {
      const archivedAttr = Task.rawAttributes.isArchived;
      expect(archivedAttr.defaultValue).toBe(false);
    });

    it('defaults autoAssigned to false', () => {
      const autoAttr = Task.rawAttributes.autoAssigned;
      expect(autoAttr.defaultValue).toBe(false);
    });

    it('defaults estimatedHours to 0', () => {
      const attr = Task.rawAttributes.estimatedHours;
      expect(Number(attr.defaultValue)).toBe(0);
    });

    it('defaults actualHours to 0', () => {
      const attr = Task.rawAttributes.actualHours;
      expect(Number(attr.defaultValue)).toBe(0);
    });

    it('defaults description to an empty string', () => {
      const attr = Task.rawAttributes.description;
      expect(attr.defaultValue).toBe('');
    });
  });

  // ── JSONB fields ───────────────────────────────────────────────────────────

  describe('JSONB field defaults', () => {
    it('defaults tags to an empty array', () => {
      const tagsAttr = Task.rawAttributes.tags;
      expect(tagsAttr.defaultValue).toEqual([]);
    });

    it('defaults customFields to an empty object', () => {
      const cfAttr = Task.rawAttributes.customFields;
      expect(cfAttr.defaultValue).toEqual({});
    });

    it('defaults approvalChain to an empty array', () => {
      const attr = Task.rawAttributes.approvalChain;
      expect(attr.defaultValue).toEqual([]);
    });

    it('tags field is not nullable', () => {
      const tagsAttr = Task.rawAttributes.tags;
      expect(tagsAttr.allowNull).toBe(false);
    });

    it('customFields field is not nullable', () => {
      const cfAttr = Task.rawAttributes.customFields;
      expect(cfAttr.allowNull).toBe(false);
    });
  });

  // ── Title validation ───────────────────────────────────────────────────────

  describe('title field', () => {
    it('requires title (allowNull false)', () => {
      const titleAttr = Task.rawAttributes.title;
      expect(titleAttr.allowNull).toBe(false);
    });

    it('has notEmpty validation on title', () => {
      const titleAttr = Task.rawAttributes.title;
      expect(titleAttr.validate.notEmpty).toBeDefined();
      expect(titleAttr.validate.notEmpty.msg).toBe('Task title is required');
    });

    it('enforces title length between 1 and 300 characters', () => {
      const titleAttr = Task.rawAttributes.title;
      expect(titleAttr.validate.len.args).toEqual([1, 300]);
    });
  });

  // ── Progress validation ────────────────────────────────────────────────────

  describe('progress field', () => {
    it('is not nullable', () => {
      const attr = Task.rawAttributes.progress;
      expect(attr.allowNull).toBe(false);
    });

    it('has min validation of 0', () => {
      const attr = Task.rawAttributes.progress;
      expect(attr.validate.min).toBe(0);
    });

    it('has max validation of 100', () => {
      const attr = Task.rawAttributes.progress;
      expect(attr.validate.max).toBe(100);
    });
  });

  // ── Status and priority ENUMs ──────────────────────────────────────────────

  describe('status ENUM values', () => {
    it('includes all expected status values', () => {
      const statusAttr = Task.rawAttributes.status;
      // ENUM values are stored on the type object, not the attribute directly
      const values = statusAttr.type.values;
      const expectedStatuses = [
        'not_started', 'ready_to_start', 'working_on_it', 'in_progress',
        'waiting_for_review', 'pending_deploy', 'stuck', 'done', 'review',
      ];
      expectedStatuses.forEach(s => {
        expect(values).toContain(s);
      });
    });

    it('status is not nullable', () => {
      const statusAttr = Task.rawAttributes.status;
      expect(statusAttr.allowNull).toBe(false);
    });
  });

  describe('priority ENUM values', () => {
    it('includes all expected priority values', () => {
      const priorityAttr = Task.rawAttributes.priority;
      // ENUM values are stored on the type object
      const values = priorityAttr.type.values;
      ['low', 'medium', 'high', 'critical'].forEach(p => {
        expect(values).toContain(p);
      });
    });

    it('priority is not nullable', () => {
      const priorityAttr = Task.rawAttributes.priority;
      expect(priorityAttr.allowNull).toBe(false);
    });
  });

  // ── Foreign key fields ─────────────────────────────────────────────────────

  describe('foreign key fields', () => {
    it('boardId is not nullable', () => {
      const attr = Task.rawAttributes.boardId;
      expect(attr.allowNull).toBe(false);
    });

    it('assignedTo defaults to null and is nullable', () => {
      const attr = Task.rawAttributes.assignedTo;
      expect(attr.allowNull).toBe(true);
      expect(attr.defaultValue).toBeNull();
    });

    it('createdBy is not nullable', () => {
      const attr = Task.rawAttributes.createdBy;
      expect(attr.allowNull).toBe(false);
    });
  });

  // ── Optional date fields ───────────────────────────────────────────────────

  describe('optional date fields', () => {
    it('dueDate is nullable and defaults to null', () => {
      const attr = Task.rawAttributes.dueDate;
      expect(attr.allowNull).toBe(true);
      expect(attr.defaultValue).toBeNull();
    });

    it('startDate is nullable and defaults to null', () => {
      const attr = Task.rawAttributes.startDate;
      expect(attr.allowNull).toBe(true);
      expect(attr.defaultValue).toBeNull();
    });
  });

  // ── Model structure ────────────────────────────────────────────────────────

  describe('model structure', () => {
    it('uses the correct table name', () => {
      expect(Task.tableName).toBe('tasks');
    });

    it('defines a UUID primary key', () => {
      const { DataTypes } = require('sequelize');
      const idAttr = Task.rawAttributes.id;
      expect(idAttr.primaryKey).toBe(true);
      expect(idAttr.defaultValue).toBe(DataTypes.UUIDV4);
    });

    it('has timestamps enabled', () => {
      expect(Task.options.timestamps).toBe(true);
    });
  });
});
