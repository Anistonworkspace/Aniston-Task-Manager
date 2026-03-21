import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ChevronLeft, X, Sparkles } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { TOUR_STEPS } from '../../utils/sopContent';

function getStorageKey(userId) {
  return `onboarding_done_${userId}`;
}

export function resetOnboarding(userId) {
  localStorage.removeItem(getStorageKey(userId));
}

export default function OnboardingTour() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  const role = user?.role || 'member';
  const steps = [...(TOUR_STEPS.common || []), ...(TOUR_STEPS[role] || TOUR_STEPS.member)];

  useEffect(() => {
    if (!user?.id) return;
    const done = localStorage.getItem(getStorageKey(user.id));
    if (!done) {
      setVisible(true);
      setStep(0);
    }
  }, [user?.id]);

  // Listen for restart event
  useEffect(() => {
    function handleRestart() {
      if (user?.id) {
        localStorage.removeItem(getStorageKey(user.id));
        setStep(0);
        setVisible(true);
      }
    }
    window.addEventListener('restart-onboarding', handleRestart);
    return () => window.removeEventListener('restart-onboarding', handleRestart);
  }, [user?.id]);

  function completeTour() {
    if (user?.id) {
      localStorage.setItem(getStorageKey(user.id), Date.now().toString());
    }
    setVisible(false);
  }

  function skipTour() {
    completeTour();
  }

  function next() {
    if (step < steps.length - 1) setStep(step + 1);
    else completeTour();
  }

  function back() {
    if (step > 0) setStep(step - 1);
  }

  if (!visible || !steps.length) return null;

  const current = steps[step];
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;
  const progress = ((step + 1) / steps.length) * 100;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">
        {/* Progress bar */}
        <div className="h-1 bg-gray-200 dark:bg-zinc-700">
          <div
            className="h-full bg-gradient-to-r from-primary to-blue-500 transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Header with skip */}
        <div className="flex items-center justify-between px-6 pt-4">
          <span className="text-xs font-medium text-text-tertiary dark:text-zinc-400">
            Step {step + 1} of {steps.length}
          </span>
          <button
            onClick={skipTour}
            className="text-xs text-text-tertiary hover:text-text-secondary dark:text-zinc-400 dark:hover:text-zinc-200 flex items-center gap-1 transition-colors"
          >
            <X size={14} />
            Skip Tour
          </button>
        </div>

        {/* Content */}
        <div className="px-8 py-6 text-center">
          {/* Icon */}
          <div className="text-5xl mb-4">{current.icon}</div>

          {/* Title */}
          <h2 className="text-xl font-bold text-text-primary dark:text-zinc-100 mb-3">
            {current.title}
          </h2>

          {/* Description */}
          <p className="text-sm text-text-secondary dark:text-zinc-300 leading-relaxed mb-4 max-w-md mx-auto">
            {current.description}
          </p>

          {/* Optional link */}
          {current.link && (
            <button
              onClick={() => {
                completeTour();
                navigate(current.link);
              }}
              className="text-sm text-primary hover:text-primary-hover font-medium underline underline-offset-2 transition-colors"
            >
              {current.linkText || 'Go there now'}
            </button>
          )}
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-1.5 pb-4">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`rounded-full transition-all duration-300 ${
                i === step
                  ? 'w-6 h-2 bg-primary'
                  : i < step
                  ? 'w-2 h-2 bg-primary/40'
                  : 'w-2 h-2 bg-gray-300 dark:bg-zinc-600'
              }`}
            />
          ))}
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-between px-6 pb-5">
          <button
            onClick={back}
            disabled={isFirst}
            className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary dark:text-zinc-400 dark:hover:text-zinc-200 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            Back
          </button>

          <button
            onClick={next}
            className={`flex items-center gap-2 px-6 py-2.5 text-sm font-semibold rounded-xl transition-all ${
              isLast
                ? 'bg-gradient-to-r from-primary to-blue-500 hover:from-primary-hover hover:to-blue-600 text-white shadow-lg shadow-primary/25'
                : 'bg-primary hover:bg-primary-hover text-white'
            }`}
          >
            {isLast ? (
              <>
                <Sparkles size={16} />
                Get Started
              </>
            ) : (
              <>
                Next
                <ChevronRight size={16} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
