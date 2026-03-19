/**
 * Reusable Framer Motion animation variants
 * Import and spread into motion components:
 *   <motion.div {...fadeInUp}>
 *   <motion.div variants={staggerItem} />
 */

// ═══ FADE + SLIDE VARIANTS ═══

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2 },
};

export const fadeInUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
};

export const fadeInDown = {
  initial: { opacity: 0, y: -12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
};

export const slideInRight = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
  transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] },
};

export const slideInLeft = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
  transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] },
};

// ═══ SCALE VARIANTS ═══

export const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
};

export const popIn = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
  transition: { type: 'spring', stiffness: 300, damping: 25 },
};

// ═══ STAGGER CONTAINERS ═══

export const staggerContainer = {
  animate: {
    transition: { staggerChildren: 0.05, delayChildren: 0.05 },
  },
};

export const staggerFast = {
  animate: {
    transition: { staggerChildren: 0.03 },
  },
};

export const staggerSlow = {
  animate: {
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

// ═══ STAGGER ITEMS (use inside stagger containers) ═══

export const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
};

export const staggerItemX = {
  initial: { opacity: 0, x: -8 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
};

// ═══ INTERACTION PROPS ═══
// Spread these onto motion elements: <motion.button {...pressable}>

export const pressable = {
  whileTap: { scale: 0.97 },
  transition: { type: 'spring', stiffness: 400, damping: 17 },
};

export const hoverLift = {
  whileHover: { y: -1, transition: { duration: 0.15 } },
};

export const hoverScale = {
  whileHover: { scale: 1.02, transition: { duration: 0.15 } },
  whileTap: { scale: 0.98 },
};

export const hoverGlow = {
  whileHover: { boxShadow: '0 4px 20px rgba(0, 115, 234, 0.12)', transition: { duration: 0.2 } },
};

// ═══ MODAL / OVERLAY ═══

export const modalOverlay = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

export const modalContent = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: 8 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
};

// ═══ SIDEBAR ═══

export const sidebarExpand = {
  initial: false,
  animate: (width) => ({ width }),
  transition: { type: 'spring', stiffness: 300, damping: 30 },
};

// ═══ DROPDOWN ═══

export const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.95, y: -4 },
  visible: {
    opacity: 1, scale: 1, y: 0,
    transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1], staggerChildren: 0.03 },
  },
  exit: { opacity: 0, scale: 0.95, y: -4, transition: { duration: 0.1 } },
};

export const dropdownItem = {
  hidden: { opacity: 0, x: -4 },
  visible: { opacity: 1, x: 0 },
};

// ═══ SPRING PRESETS ═══

export const springs = {
  gentle: { type: 'spring', stiffness: 120, damping: 14 },
  snappy: { type: 'spring', stiffness: 300, damping: 25 },
  bouncy: { type: 'spring', stiffness: 400, damping: 10 },
  stiff: { type: 'spring', stiffness: 500, damping: 30 },
};

// ═══ EASING PRESETS ═══

export const easings = {
  smooth: [0.16, 1, 0.3, 1],
  easeOut: [0, 0, 0.2, 1],
  easeIn: [0.4, 0, 1, 1],
  spring: [0.34, 1.56, 0.64, 1],
};
