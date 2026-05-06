'use strict';

const { sendIfTierError, sendIfTierErrorAsync } = require('../../utils/tierResponseHelpers');
const { TierError } = require('../../config/tiers');

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  };
}

describe('sendIfTierError (sync)', () => {
  it('returns false when fn does not throw', () => {
    const res = buildRes();
    const sent = sendIfTierError(res, () => { /* no-op */ });
    expect(sent).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('catches TierError and sends 4xx with code', () => {
    const res = buildRes();
    const sent = sendIfTierError(res, () => {
      throw new TierError('nope', { status: 403, code: 'TIER_2_NO_DELETE' });
    });
    expect(sent).toBe(true);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'nope',
      code: 'TIER_2_NO_DELETE',
    });
  });

  it('re-throws non-TierError exceptions', () => {
    const res = buildRes();
    expect(() =>
      sendIfTierError(res, () => { throw new Error('boom'); })
    ).toThrow(/boom/);
  });
});

describe('sendIfTierErrorAsync', () => {
  it('returns false when fn resolves', async () => {
    const res = buildRes();
    const sent = await sendIfTierErrorAsync(res, async () => { /* no-op */ });
    expect(sent).toBe(false);
  });

  it('catches TierError and sends 4xx with code', async () => {
    const res = buildRes();
    const sent = await sendIfTierErrorAsync(res, async () => {
      throw new TierError('blocked', { status: 400, code: 'LAST_TIER_1' });
    });
    expect(sent).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'blocked',
      code: 'LAST_TIER_1',
    });
  });

  it('re-throws non-TierError exceptions', async () => {
    const res = buildRes();
    await expect(
      sendIfTierErrorAsync(res, async () => { throw new Error('db crash'); })
    ).rejects.toThrow(/db crash/);
  });
});
