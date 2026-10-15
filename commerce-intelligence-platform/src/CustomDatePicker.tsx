import React, { useState, useRef, useEffect, useMemo } from 'react'
import styles from './CustomDatePicker.module.css'

interface CustomDatePickerProps {
  id: string
  label: string
  value: string // Format: 'YYYY-MM-DDTHH:mm'
  onChange: (value: string) => void
  align?: 'left' | 'right'
  presetType?: 'start' | 'end'
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function parseDateTimeString(str: string) {
  if (!str) {
    return { year: 2026, month: 9, day: 8, hour: 0, minute: 0 }
  }
  const [datePart, timePart] = str.split('T')
  if (!datePart) {
    return { year: 2026, month: 9, day: 8, hour: 0, minute: 0 }
  }
  const [y, m, d] = datePart.split('-').map(Number)
  const [hh, mm] = (timePart || '00:00').split(':').map(Number)
  return {
    year: y || 2026,
    month: Math.max(0, Math.min(11, (m || 10) - 1)),
    day: Math.max(1, Math.min(31, d || 1)),
    hour: isNaN(hh) ? 0 : Math.max(0, Math.min(23, hh)),
    minute: isNaN(mm) ? 0 : Math.max(0, Math.min(59, mm)),
  }
}

function formatDisplayDate(str: string): string {
  if (!str) return 'Choose date & time'
  const { year, month, day, hour, minute } = parseDateTimeString(str)
  const d = new Date(year, month, day, hour, minute)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayName = isNaN(d.getDay()) ? 'Day' : dayNames[d.getDay()]
  return `${dayName}, ${pad(day)} ${MONTH_SHORT[month]} ${year} · ${pad(hour)}:${pad(minute)}`
}

export const CustomDatePicker: React.FC<CustomDatePickerProps> = ({
  id,
  label,
  value,
  onChange,
  align = 'left',
  presetType = 'start',
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => parseDateTimeString(value), [value])

  const [viewYear, setViewYear] = useState<number>(selected.year)
  const [viewMonth, setViewMonth] = useState<number>(selected.month)

  // Sync view when opened
  useEffect(() => {
    if (isOpen) {
      setViewYear(selected.year)
      setViewMonth(selected.month)
    }
  }, [isOpen, selected.year, selected.month])

  // Handle outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear((prev) => prev - 1)
    } else {
      setViewMonth((prev) => prev - 1)
    }
  }

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear((prev) => prev + 1)
    } else {
      setViewMonth((prev) => prev + 1)
    }
  }

  const handleDaySelect = (day: number, month = viewMonth, year = viewYear) => {
    const newStr = `${year}-${pad(month + 1)}-${pad(day)}T${pad(selected.hour)}:${pad(selected.minute)}`
    onChange(newStr)
  }

  const handleTimeChange = (hour: number, minute: number) => {
    const clampedH = Math.max(0, Math.min(23, hour))
    const clampedM = Math.max(0, Math.min(59, minute))
    const newStr = `${selected.year}-${pad(selected.month + 1)}-${pad(selected.day)}T${pad(clampedH)}:${pad(clampedM)}`
    onChange(newStr)
  }

  const handleIncrementHour = () => {
    handleTimeChange((selected.hour + 1) % 24, selected.minute)
  }

  const handleDecrementHour = () => {
    handleTimeChange((selected.hour - 1 + 24) % 24, selected.minute)
  }

  const handleIncrementMinute = () => {
    let next = 0
    if (selected.minute < 15) next = 15
    else if (selected.minute < 30) next = 30
    else if (selected.minute < 45) next = 45
    else if (selected.minute < 59) next = 59
    else next = 0
    handleTimeChange(selected.hour, next)
  }

  const handleDecrementMinute = () => {
    let next = 59
    if (selected.minute > 45) next = 45
    else if (selected.minute > 30) next = 30
    else if (selected.minute > 15) next = 15
    else if (selected.minute > 0) next = 0
    else next = 59
    handleTimeChange(selected.hour, next)
  }

  const handlePresetSelect = (dateStr: string) => {
    onChange(dateStr)
  }

  // Calculate calendar grid
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay()
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate()

  const calendarDays = useMemo(() => {
    const days: Array<{ day: number; month: number; year: number; isOutside: boolean }> = []

    // Previous month trailing days
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const d = prevMonthDays - i
      const m = viewMonth === 0 ? 11 : viewMonth - 1
      const y = viewMonth === 0 ? viewYear - 1 : viewYear
      days.push({ day: d, month: m, year: y, isOutside: true })
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({ day: d, month: viewMonth, year: viewYear, isOutside: false })
    }

    // Next month leading days to complete the 35 or 42 grid
    const totalSlots = days.length <= 35 ? 35 : 42
    const remaining = totalSlots - days.length
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1
      const y = viewMonth === 11 ? viewYear + 1 : viewYear
      days.push({ day: d, month: m, year: y, isOutside: true })
    }

    return days
  }, [viewYear, viewMonth, daysInMonth, firstDayOfWeek, prevMonthDays])

  // Presets tailored for Magrabi dataset (Sept-Oct 2026)
  const presets =
    presetType === 'start'
      ? [
          { label: '01 Oct', value: '2026-10-01T00:00' },
          { label: '08 Oct (7d)', value: '2026-10-08T00:00' },
          { label: '14 Oct', value: '2026-10-14T00:00' },
          { label: '15 Oct', value: '2026-10-15T00:00' },
        ]
      : [
          { label: '08 Oct', value: '2026-10-08T00:00' },
          { label: '14 Oct', value: '2026-10-14T00:00' },
          { label: '15 Oct (Start)', value: '2026-10-15T00:00' },
          { label: '15 Oct (End)', value: '2026-10-15T23:59' },
        ]

  // Time preset buttons
  const timePresets = [
    { label: '00:00 (Start)', h: 0, m: 0 },
    { label: '09:00 (Morning)', h: 9, m: 0 },
    { label: '12:00 (Noon)', h: 12, m: 0 },
    { label: '15:00 (Afternoon)', h: 15, m: 0 },
    { label: '18:00 (Evening)', h: 18, m: 0 },
    { label: '23:59 (End of day)', h: 23, m: 59 },
  ]

  return (
    <div className={styles.container} ref={containerRef}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>

      {/* Hidden input for form values */}
      <input type="hidden" id={id} name={id} value={value} />

      {/* Styled Trigger Button */}
      <button
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.triggerActive : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <div className={styles.triggerContent}>
          <span className={styles.triggerIcon}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </span>
          <span>{formatDisplayDate(value)}</span>
        </div>
        <svg
          className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Popover */}
      {isOpen && (
        <div
          className={`${styles.popover} ${align === 'right' ? styles.popoverRight : styles.popoverLeft}`}
          role="dialog"
          aria-modal="true"
        >
          {/* Quick Presets */}
          <div className={styles.presetsRow}>
            <span className={styles.presetLabel}>Quick:</span>
            {presets.map((p) => {
              const isActive = value === p.value
              return (
                <button
                  key={p.value}
                  type="button"
                  className={`${styles.presetBtn} ${isActive ? styles.presetBtnActive : ''}`}
                  onClick={() => handlePresetSelect(p.value)}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          {/* Month / Year Header */}
          <div className={styles.header}>
            <button
              type="button"
              className={styles.navBtn}
              onClick={handlePrevMonth}
              title="Previous Month"
              aria-label="Previous Month"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div className={styles.monthTitle}>
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              className={styles.navBtn}
              onClick={handleNextMonth}
              title="Next Month"
              aria-label="Next Month"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>

          {/* Weekday Labels */}
          <div className={styles.weekdaysGrid}>
            {WEEKDAYS.map((wd) => (
              <span key={wd} className={styles.weekday}>
                {wd}
              </span>
            ))}
          </div>

          {/* Calendar Days Grid */}
          <div className={styles.daysGrid}>
            {calendarDays.map((item, idx) => {
              const isSelected =
                !item.isOutside &&
                item.day === selected.day &&
                item.month === selected.month &&
                item.year === selected.year

              const isToday =
                item.year === 2026 && item.month === 9 && item.day === 15 // Current demo date baseline

              return (
                <button
                  key={`${item.year}-${item.month}-${item.day}-${idx}`}
                  type="button"
                  className={`
                    ${styles.dayBtn}
                    ${item.isOutside ? styles.dayBtnOutside : ''}
                    ${isSelected ? styles.dayBtnSelected : ''}
                    ${isToday ? styles.dayBtnToday : ''}
                  `}
                  onClick={() => handleDaySelect(item.day, item.month, item.year)}
                >
                  {item.day}
                </button>
              )
            })}
          </div>

          {/* Luxury Time Section */}
          <div className={styles.timeCard}>
            <div className={styles.timeCardHeader}>
              <span className={styles.timeCardLabel}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Time Selection
              </span>

              {/* Digital Clock Stepper */}
              <div className={styles.digitalClock}>
                <div className={styles.stepperUnit}>
                  <span className={styles.timeDisplay}>{pad(selected.hour)}</span>
                  <div className={styles.stepperActions}>
                    <button
                      type="button"
                      className={styles.stepperBtn}
                      onClick={handleIncrementHour}
                      title="Next Hour"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.stepperBtn}
                      onClick={handleDecrementHour}
                      title="Previous Hour"
                    >
                      ▼
                    </button>
                  </div>
                </div>
                <span className={styles.clockColon}>:</span>
                <div className={styles.stepperUnit}>
                  <span className={styles.timeDisplay}>{pad(selected.minute)}</span>
                  <div className={styles.stepperActions}>
                    <button
                      type="button"
                      className={styles.stepperBtn}
                      onClick={handleIncrementMinute}
                      title="Next 15m"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.stepperBtn}
                      onClick={handleDecrementMinute}
                      title="Previous 15m"
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Time Chips */}
            <div className={styles.timeChipsGrid}>
              {timePresets.map((tp) => {
                const isChipActive = selected.hour === tp.h && selected.minute === tp.m
                return (
                  <button
                    key={tp.label}
                    type="button"
                    className={`${styles.timeChip} ${isChipActive ? styles.timeChipActive : ''}`}
                    onClick={() => handleTimeChange(tp.h, tp.m)}
                  >
                    {tp.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Footer with Summary and Done button */}
          <div className={styles.footer}>
            <div className={styles.selectedSummary}>
              <span>Selected:</span>
              <span className={styles.selectedBadge}>
                {pad(selected.day)} {MONTH_SHORT[selected.month]} · {pad(selected.hour)}:{pad(selected.minute)}
              </span>
            </div>
            <button type="button" className={styles.doneBtn} onClick={() => setIsOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
