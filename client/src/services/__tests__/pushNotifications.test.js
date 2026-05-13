import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Pin the May 2026 fixes around showLocalNotification:
//
//   (a) Focus-policy fix: must fire OS notifications regardless of tab
//       focus state. The pre-fix code bailed on a focused tab.
//
//   (b) SW-vs-fallback fix: the function MUST use the `new Notification()`
//       constructor when no active SW controller is present. The pre-fix
//       code branched on `navigator.serviceWorker.ready` (always a Promise,
//       always truthy), which meant in dev mode (where main.jsx never
//       registers a SW) `.ready` never resolved and the fallback was never
//       reached. Result: foreground OS notifications were silently
//       impossible in dev.
//
// Tests run in jsdom; we mock both `controller` and `ready` independently
// so we can exercise each branch deterministically.

describe('showLocalNotification — focus + SW path policy (May 2026)', () => {
  let originalNotification;
  let originalServiceWorker;
  let originalGlobalNotificationCtor;
  let swShowNotificationMock;
  let constructorCalls;

  beforeEach(() => {
    // Notification static API (permission, requestPermission). We also
    // need the function to be CONSTRUCTIBLE because the fallback uses
    // `new Notification(title, options)`. Replace the class entirely so
    // tests can spy on construction.
    originalNotification = global.Notification;
    constructorCalls = [];
    class MockNotification {
      static permission = 'granted';
      static requestPermission = vi.fn().mockResolvedValue('granted');
      constructor(title, options) {
        constructorCalls.push({ title, options });
        this.title = title;
        this.options = options;
        this.onclick = null;
        this.close = vi.fn();
      }
    }
    global.Notification = MockNotification;
    originalGlobalNotificationCtor = MockNotification;

    swShowNotificationMock = vi.fn().mockResolvedValue(undefined);
    originalServiceWorker = navigator.serviceWorker;
  });

  afterEach(() => {
    global.Notification = originalNotification;
    if (originalServiceWorker === undefined) {
      delete navigator.serviceWorker;
    } else {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: originalServiceWorker,
      });
    }
    vi.restoreAllMocks();
  });

  /** Helper: install a SW with an active controller (prod-like). */
  function installActiveServiceWorker() {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { state: 'activated' },
        ready: Promise.resolve({ showNotification: swShowNotificationMock }),
      },
    });
  }

  /** Helper: install a SW that never activates (dev-like). */
  function installNoControllerServiceWorker() {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null, // <- critical: SW registered but not controlling
        // ready intentionally returns a never-resolving Promise to model
        // the real dev case. The fix MUST NOT block on this.
        ready: new Promise(() => {}),
      },
    });
  }

  test('uses SW path when controller is active and tab is focused', async () => {
    installActiveServiceWorker();
    // Reproduce focused-tab state — pre-fix this bailed.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    const { showLocalNotification } = await import('../pushNotifications');
    await showLocalNotification('Task assigned', {
      body: 'You have been assigned to "design login"',
      tag: 'notif-abc-123',
      url: '/boards/x?taskId=abc-123',
      notificationId: 'abc-123',
    });

    expect(swShowNotificationMock).toHaveBeenCalledTimes(1);
    expect(swShowNotificationMock).toHaveBeenCalledWith(
      'Task assigned',
      expect.objectContaining({
        body: 'You have been assigned to "design login"',
        tag: 'notif-abc-123',
        renotify: false,
        data: expect.objectContaining({ url: '/boards/x?taskId=abc-123' }),
      }),
    );
    // Constructor fallback NOT used when SW path succeeds.
    expect(constructorCalls).toHaveLength(0);
    hasFocusSpy.mockRestore();
  });

  test('falls back to new Notification() when no SW controller (dev mode)', async () => {
    installNoControllerServiceWorker();

    const { showLocalNotification } = await import('../pushNotifications');
    await showLocalNotification('Task assigned', {
      body: 'hi',
      tag: 'notif-dev-1',
      url: '/',
    });

    // Critical: in dev (no controller) the SW path is skipped and the
    // constructor IS called — restoring OS notifications on localhost.
    expect(swShowNotificationMock).not.toHaveBeenCalled();
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].title).toBe('Task assigned');
    expect(constructorCalls[0].options).toEqual(expect.objectContaining({
      body: 'hi',
      tag: 'notif-dev-1',
    }));
  });

  test('falls back to new Notification() when SW.ready stalls past timeout', async () => {
    // Install SW with controller present but ready that never resolves —
    // models a rare prod state where the registration is partially live.
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { state: 'activated' },
        ready: new Promise(() => {}),
      },
    });
    vi.useFakeTimers();

    try {
      const { showLocalNotification } = await import('../pushNotifications');
      const done = showLocalNotification('Stalled SW', { body: 'b', tag: 'notif-stall' });
      // Advance past the 800ms internal timeout.
      await vi.advanceTimersByTimeAsync(900);
      await done;

      expect(swShowNotificationMock).not.toHaveBeenCalled();
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].title).toBe('Stalled SW');
    } finally {
      vi.useRealTimers();
    }
  });

  test('does NOT fire when permission is denied', async () => {
    installActiveServiceWorker();
    global.Notification.permission = 'denied';
    const { showLocalNotification } = await import('../pushNotifications');

    await showLocalNotification('Task assigned', { body: 'hello', tag: 'notif-1' });

    expect(swShowNotificationMock).not.toHaveBeenCalled();
    expect(constructorCalls).toHaveLength(0);
  });

  test('does NOT fire when permission is default', async () => {
    installActiveServiceWorker();
    global.Notification.permission = 'default';
    const { showLocalNotification } = await import('../pushNotifications');

    await showLocalNotification('Task assigned', { body: 'hello', tag: 'notif-1' });

    expect(swShowNotificationMock).not.toHaveBeenCalled();
    expect(constructorCalls).toHaveLength(0);
  });

  test('fires even when document.hidden=true (unfocused tab)', async () => {
    installActiveServiceWorker();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    try {
      const { showLocalNotification } = await import('../pushNotifications');
      await showLocalNotification('Task assigned', { body: 'hello', tag: 'notif-1' });
      expect(swShowNotificationMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    }
  });

  test('forwards the stable notif-<id> tag so SW push and foreground tag-collapse', async () => {
    installActiveServiceWorker();
    const { showLocalNotification } = await import('../pushNotifications');
    await showLocalNotification('Anything', { body: 'b', tag: 'notif-stable-id' });
    expect(swShowNotificationMock).toHaveBeenCalledWith(
      'Anything',
      expect.objectContaining({ tag: 'notif-stable-id' }),
    );
  });

  test('falls back to new Notification() when reg.showNotification rejects', async () => {
    // SW exists + controller present, but the call rejects (e.g., browser
    // returned a "no permission" error mid-call).
    const rejecting = vi.fn().mockRejectedValue(new Error('show-notif-failed'));
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { state: 'activated' },
        ready: Promise.resolve({ showNotification: rejecting }),
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { showLocalNotification } = await import('../pushNotifications');
    await showLocalNotification('Title', { body: 'b', tag: 'notif-fail' });

    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(constructorCalls).toHaveLength(1); // safety-net constructor path
    expect(constructorCalls[0].title).toBe('Title');
    warnSpy.mockRestore();
  });
});
