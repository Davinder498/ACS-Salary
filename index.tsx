import { clearBrowserCache } from './cacheCleaner';
clearBrowserCache(); // Clear old service workers and caches

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { createClient } from '@supabase/supabase-js';
import './index.css';

fetch('/metadata.json')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data) {
      console.warn('metadata.json not found, skipping version check');
      return;
    }
    const currentVersion = localStorage.getItem('app_version');
    if (currentVersion && currentVersion !== data.build) {
      localStorage.setItem('app_version', data.build);
      window.location.reload();
    } else if (!currentVersion) {
      localStorage.setItem('app_version', data.build);
    }
  })
  .catch(() => console.warn('Failed to fetch metadata.json'));

// Clear old caches automatically on app load
if ('caches' in window) {
  caches.keys().then(keys => {
    keys.forEach(key => caches.delete(key));
  });
}

// --- Supabase Configuration ---
// IMPORTANT: For local development in AI Studio, replace these placeholders.
// You can get these from your Supabase project's "Project Settings" > "API".
const SUPABASE_URL_PLACEHOLDER = "https://ksubndttngntzmkafmdq.supabase.co";
const SUPABASE_ANON_KEY_PLACEHOLDER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtzdWJuZHR0bmdudHpta2FmbWRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIzMjU3MjYsImV4cCI6MjA2NzkwMTcyNn0.O11tjXXVwPXePrqEDH4E6es-_Eu-1k8dxd_7cuf3d3o";

// In a Vite build, `import.meta.env` will be populated. In other environments, it may be undefined.
// This helper safely checks for Vite, then Node.js-style environment variables.
const getSupabaseEnv = (key: string): string | undefined => {
    const viteKey = `VITE_${key}`;
    // 1. Check for Vite's `import.meta.env`
    if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env[viteKey]) {
        return (import.meta as any).env[viteKey];
    }
    // 2. Check for Node.js-style `process.env`
    if (typeof process !== 'undefined' && process.env) {
        return process.env[viteKey] || process.env[key];
    }
    return undefined;
};

// The app will try to use environment variables first, then fall back to the placeholders.
const SUPABASE_URL = getSupabaseEnv('SUPABASE_URL') || SUPABASE_URL_PLACEHOLDER;
const SUPABASE_ANON_KEY = getSupabaseEnv('SUPABASE_ANON_KEY') || SUPABASE_ANON_KEY_PLACEHOLDER;

// Check if the keys are still the default placeholders.
const isSupabaseConfigured =
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    SUPABASE_URL !== "https://your-project-id.supabase.co" &&
    SUPABASE_ANON_KEY !== "your-anon-public-key-here";

const supabase = isSupabaseConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : {} as any;

// --- DATA INTERFACES ---
interface WorkCycleReference {
  date: string;
  day: number;
  pattern: Array<'D' | 'A' | 'N' | 'O'>;
}
interface ProfileData {
  baseRate: number;
  workCycleReference: WorkCycleReference | null;
}
interface Shift {
    type: 'D' | 'A' | 'N' | 'O';
    category: 'Regular' | 'First Overtime' | 'Second Overtime';
    hasEscort: boolean;
    isBanked: boolean;
    isBookedOff: boolean;
}
interface ShiftsData { [key: string]: Shift[] };
interface CashedOutHoursData { [key: string]: number };

interface UserData {
  email: string | null;
  profile: ProfileData;
  shifts: ShiftsData;
  cashedOutHours: CashedOutHoursData;
}

type User = UserData & {
  uid: string;
};

interface PayDetails {
    hours: number;
    pay: number;
}

interface DeferredPay {
    ot1_5x: PayDetails;
    ot2x: PayDetails;
    afternoon: PayDetails;
    night: PayDetails;
    weekend: PayDetails;
    stm: PayDetails;
    statHolidayBonus: PayDetails;
}

interface SalaryCalculationResult {
    regularPay: PayDetails;
    deferred: DeferredPay;
    equivalentBankedOtHours: number;
}

interface LedgerEntry {
    ppNumber: number;
    year: number;
    globalPPNumber: number;
    data: SalaryCalculationResult;
    cashedOut: number;
    startBalance: number;
    endBalance: number;
    grossPay: number;
    deferredPayFromPrevious: number;
    ytdGross: number;
}

interface PayPeriod {
    number: number;
    payPeriodOfYear: number;
    year: number;
    start: Date;
    end: Date;
}

interface AnnualProjectionData {
    year: number;
    totalGrossPay: number;
    breakdown: DeferredPay & { baseSalary: PayDetails };
}


// --- API ---
const api = {
    register: async (email: string, password: string) => {
        if (!isSupabaseConfigured) throw new Error("Database not configured.");
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        return { data, error: null };
    },
    login: async (email: string, password: string) => {
        if (!isSupabaseConfigured) throw new Error("Database not configured.");
        return await supabase.auth.signInWithPassword({ email, password });
    },
    sendPasswordResetEmail: async (email: string) => {
        if (!isSupabaseConfigured) throw new Error("Database not configured.");
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin,
        });
        if (error) throw error;
    },
    logout: async () => {
        if (!isSupabaseConfigured) return;
        const { error } = await supabase.auth.signOut();
        if (error) {
            console.error("Error logging out:", error);
            alert(`Could not log out: ${error.message}`);
        }
    },
    getUserData: async (uid: string): Promise<UserData> => {
        if (!isSupabaseConfigured) throw new Error("Database not configured.");
        
        const { data, error } = await supabase
            .from('profiles')
            .select('email, profile, shifts, cashedOutHours: cashedouthours')
            .eq('id', uid)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 means 0 rows found
            console.error("Error fetching profile:", error);
            throw error;
        }

        if (data) {
             // Ensure existing users have a profile object.
            if (!data.profile) {
                data.profile = {
                    baseRate: 0,
                    workCycleReference: null,
                };
            }
             // Backwards compatibility: Add default pattern if missing for existing users
            if (data.profile.workCycleReference && !data.profile.workCycleReference.pattern) {
                data.profile.workCycleReference.pattern = ['A', 'A', 'A', 'D', 'D', 'D', 'O', 'O', 'O'];
            }
            return {
                email: data.email || null,
                profile: data.profile,
                shifts: data.shifts || {},
                cashedOutHours: data.cashedOutHours || {},
            } as UserData;
        }

        // If no profile exists, create a default one for the new user.
        const { data: authData, error: authError } = await supabase.auth.getUser();
        
        if(authError) {
            console.error("Error fetching authenticated user:", authError);
            throw authError;
        }
        if (!authData.user) {
            console.error("Authenticated user not found when creating profile.");
            throw new Error("Authenticated user not found.");
        }

        const newUserData: UserData = {
            email: authData.user.email || null,
            profile: { 
                baseRate: 0, 
                workCycleReference: {
                    date: toISODateString(new Date()),
                    day: 1,
                    pattern: ['A', 'A', 'A', 'D', 'D', 'D', 'O', 'O', 'O'],
                }
            },
            shifts: {},
            cashedOutHours: {}
        };
        
        await api.saveUserData(uid, newUserData);
        return newUserData;
    },
    saveUserData: async (uid: string, dataToSave: Partial<UserData>) => {
        if (!isSupabaseConfigured) throw new Error("Database not configured.");

        const { cashedOutHours, ...restData } = dataToSave;
        
        const payload = {
            id: uid,
            ...restData,
            ...(cashedOutHours !== undefined && { cashedouthours: cashedOutHours }),
        };

        const { error } = await supabase
            .from('profiles')
            .upsert(payload);

        if (error) {
            console.error("Error saving user data:", error);
            throw error;
        }
    }
};
// --- End of inlined Supabase code ---


// --- START: Consolidated Application Code ---

// --- SVG ICONS ---
const DashboardIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 12v5h12V8H7z"/><path d="M11 12v5"/><path d="M15 12v5"/><path d="M7 8V5l4 3 4-3v3"/></svg>);
const ScheduleIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
const ProfileIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>);
const LedgerIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>);
const DownloadIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>);
const SunIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>);
const MoonIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>);
const ListIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>);
const BarChartIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>);

// --- CONSTANTS & HELPERS ---
const BASE_PAY_PERIOD_START_DATE = new Date('2024-12-22T00:00:00');
const PAY_PERIOD_LENGTH_DAYS = 14;
const WORK_CYCLE_LENGTH_DAYS = 9;

const toISODateString = (date: Date): string => {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
};

// --- STAT HOLIDAY CALCULATION ---
const findNthWeekday = (year: number, month: number, weekday: number, n: number): Date | null => {
    let count = 0;
    for (let day = 1; day <= 31; day++) {
        const date = new Date(year, month, day);
        if (date.getMonth() !== month) break;
        if (date.getDay() === weekday) { 
            count++;
            if (count === n) {
                return date;
            }
        }
    }
    return null;
};

const findLastMondayBefore = (year: number, month: number, day: number): Date => {
    const d = new Date(year, month, day);
    d.setDate(d.getDate() - 1);
    while(d.getDay() !== 1) { 
        d.setDate(d.getDate() - 1);
    }
    return d;
};

const getStatHolidaysForYear = (year: number): Record<string, string> => {
    const holidays: Record<string, string> = {};
    const goodFridays: Record<number, string> = {
        2024: '2024-03-29', 2025: '2025-04-18', 2026: '2026-04-03',
        2027: '2027-03-26', 2028: '2028-04-14', 2029: '2029-04-06',
        2030: '2030-04-19', 2031: '2031-04-11', 2032: '2032-03-26',
        2033: '2033-04-15', 2034: '2034-04-07'
    };
    if(goodFridays[year]) holidays[goodFridays[year]] = "Good Friday";
    holidays[`${year}-01-01`] = "New Year's Day";
    let canadaDay = new Date(year, 6, 1);
    if (canadaDay.getDay() === 0) { 
        canadaDay.setDate(2);
    }
    holidays[toISODateString(canadaDay)] = "Canada Day";
    holidays[`${year}-11-11`] = "Remembrance Day";
    holidays[`${year}-12-25`] = "Christmas Day";
    const familyDay = findNthWeekday(year, 1, 1, 3);
    if(familyDay) holidays[toISODateString(familyDay)] = "Alberta Family Day";
    const victoriaDay = findLastMondayBefore(year, 4, 25);
    if(victoriaDay) holidays[toISODateString(victoriaDay)] = "Victoria Day";
    const heritageDay = findNthWeekday(year, 7, 1, 1);
    if(heritageDay) holidays[toISODateString(heritageDay)] = "Heritage Day";
    const labourDay = findNthWeekday(year, 8, 1, 1);
    if(labourDay) holidays[toISODateString(labourDay)] = "Labour Day";
    const thanksgivingDay = findNthWeekday(year, 9, 1, 2);
    if(thanksgivingDay) holidays[toISODateString(thanksgivingDay)] = "Thanksgiving Day";

    return holidays;
};

const addDays = (date: Date, days: number): Date => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
};

const getWorkCycleDayName = (day: number | null | undefined): string => {
    if (day === null || day === undefined) return '';
    if (day >= 1 && day <= 6) return `Day ${day}`;
    if (day === 7) return 'Day 1 Off';
    if (day === 8) return 'Day 2 Off';
    if (day === 9) return 'Day 3 Off';
    return '';
};

const getWorkCycleDayForDate = (date: Date, profile: ProfileData): number | null => {
    if (!profile || !profile.workCycleReference || !profile.workCycleReference.date || !profile.workCycleReference.day) {
        return null;
    }
    const refDateObj = new Date(profile.workCycleReference.date + 'T00:00:00');
    const currentDateObj = new Date(toISODateString(date) + 'T00:00:00');
    const diffTime = currentDateObj.getTime() - refDateObj.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    return ((profile.workCycleReference.day - 1 + diffDays) % WORK_CYCLE_LENGTH_DAYS + WORK_CYCLE_LENGTH_DAYS) % WORK_CYCLE_LENGTH_DAYS + 1;
};

// This function is the new single source of truth for what shifts are on a given day.
// It checks for manual overrides first, then falls back to the work cycle pattern.
const getEffectiveShiftsForDate = (date: Date, allShifts: ShiftsData, profile: ProfileData): Shift[] => {
    const isoDate = toISODateString(date);

    // 1. Check for manual overrides for this date.
    const manualShifts = allShifts?.[isoDate];
    if (manualShifts && manualShifts.length > 0) {
        // An explicit 'O' (Off) takes precedence and is stored as such.
        const offShift = manualShifts.find(s => s.type === 'O');
        if (offShift) return [offShift];
        return manualShifts;
    }

    // 2. No override, so use the work cycle pattern.
    const dayInCycle = getWorkCycleDayForDate(date, profile);
    const pattern = profile?.workCycleReference?.pattern;
    if (dayInCycle && pattern && pattern.length === WORK_CYCLE_LENGTH_DAYS) {
        const shiftType = pattern[dayInCycle - 1];
        if (shiftType !== 'O') {
            return [{ type: shiftType, category: 'Regular', hasEscort: false, isBanked: false, isBookedOff: false }];
        }
    }

    // 3. Default to empty (off).
    return [];
};

const getCurrentPayPeriodIndex = (payPeriods: PayPeriod[]): number => {
    const today = new Date();
    const todayISO = toISODateString(today);

    const index = payPeriods.findIndex(pp => {
        const startISO = toISODateString(pp.start);
        const endISO = toISODateString(pp.end);
        return todayISO >= startISO && todayISO <= endISO;
    });

    return index >= 0 ? index : 0;
};

// --- CORE CALCULATION LOGIC ---
const calculateSalaryForPayPeriod = (payPeriod: PayPeriod | null, allShifts: ShiftsData, profile: ProfileData, allStatHolidays: Record<string, string>): SalaryCalculationResult | null => {
    const baseRate = profile?.baseRate;
    const initialResult: SalaryCalculationResult = {
        regularPay: { hours: 77.5, pay: 0 }, // Base hours are fixed for a pay period
        deferred: {
            ot1_5x: { hours: 0, pay: 0 },
            ot2x: { hours: 0, pay: 0 },
            afternoon: { hours: 0, pay: 0 },
            night: { hours: 0, pay: 0 },
            weekend: { hours: 0, pay: 0 },
            stm: { hours: 0, pay: 0 },
            statHolidayBonus: { hours: 0, pay: 0 }
        },
        equivalentBankedOtHours: 0
    };

    if (!payPeriod || !baseRate || baseRate <= 0 || !profile.workCycleReference) {
        if (!payPeriod) return null;
        if (baseRate && baseRate > 0) {
            initialResult.regularPay.pay = 77.5 * baseRate;
        }
        return initialResult;
    }
    
    initialResult.regularPay.pay = 77.5 * baseRate;

    const deferred = JSON.parse(JSON.stringify(initialResult.deferred));
    let equivalentBankedOtHours = 0;

    for (let i = 0; i < PAY_PERIOD_LENGTH_DAYS; i++) {
        const date = addDays(payPeriod.start, i);
        const isoDate = toISODateString(date);
        
        // Get shifts for the day. With the new logic, effective/displayed shifts are the same as starting/calculated shifts.
        const shiftsToProcess = getEffectiveShiftsForDate(date, allShifts, profile);
        
        const workCycleDay = getWorkCycleDayForDate(date, profile);
        const isStatHoliday = !!allStatHolidays[isoDate];

        shiftsToProcess.forEach(shift => {
            if (shift.type === 'O') return; // Skip 'Off' shifts completely

            // --- Overtime Calculation ---
            if (shift.category !== 'Regular') {
                let otPay1_5x = 0, otHours1_5x = 0;
                let otPay2x = 0, otHours2x = 0;
                
                const isWorkDay = workCycleDay !== null && workCycleDay >= 1 && workCycleDay <= 6;
                
                if (isWorkDay && !isStatHoliday) {
                    if (shift.category === 'First Overtime') {
                        // Rule: OT on a regular work day is 7.5h total, split into 2h@1.5x and 5.5h@2x
                        otHours1_5x = 2;
                        otPay1_5x = 2 * 1.5 * baseRate;
                        otHours2x = 5.5;
                        otPay2x = 5.5 * 2 * baseRate;
                    } else { // 'Second Overtime' on a regular work day
                        // Assumption: Second OT on a workday is a full 7.75h shift at 2.0x
                        const otHours = 7.75;
                        otHours2x = otHours;
                        otPay2x = otHours * 2.0 * baseRate;
                    }
                } 
                // Rule: OT on a day off or stat is 7.75h total
                else {
                    const otHours = 7.75;
                    let rateMultiplier = 0;
                    const isDay1Off = workCycleDay === 7;

                    // On Day 1 Off or a Stat Holiday, the rate depends on the OT type
                    if (isDay1Off || isStatHoliday) {
                         rateMultiplier = shift.category === 'First Overtime' ? 1.5 : 2.0;
                    } 
                    // On Day 2/3 Off, any OT is 2.0x
                    else { 
                         rateMultiplier = 2.0;
                    }
                    
                    if (rateMultiplier === 1.5) {
                        otHours1_5x = otHours;
                        otPay1_5x = otHours * 1.5 * baseRate;
                    } else if (rateMultiplier === 2.0) {
                        otHours2x = otHours;
                        otPay2x = otHours * 2.0 * baseRate;
                    }
                }
                
                const totalOtPay = otPay1_5x + otPay2x;

                if (shift.isBanked) {
                    equivalentBankedOtHours += totalOtPay / baseRate;
                } else {
                    deferred.ot1_5x.hours += otHours1_5x;
                    deferred.ot1_5x.pay += otPay1_5x;
                    deferred.ot2x.hours += otHours2x;
                    deferred.ot2x.pay += otPay2x;
                }
            } 
            // --- Regular Shift Calculation ---
            else {
                // Rule: Working a regular shift on a stat holiday provides a 0.5x bonus (total value is 1.5x)
                if (isStatHoliday) {
                    deferred.statHolidayBonus.hours += 7.75;
                    deferred.statHolidayBonus.pay += 7.75 * 0.5 * baseRate;
                }

                if (!shift.isBookedOff) {
                    // Rule: Shift differentials
                    if (shift.type === 'A') {
                        deferred.afternoon.hours += 7.75;
                        deferred.afternoon.pay += 7.75 * 2.75;
                    }
                    if (shift.type === 'N') {
                        deferred.night.hours += 7.75;
                        deferred.night.pay += 7.75 * 5.00;
                    }
                    
                    // Rule: Weekend Premium
                    const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon... 6=Sat
                    const isWeekendShift = (dayOfWeek === 6) || (dayOfWeek === 0) || (dayOfWeek === 5 && shift.type === 'A');
                    if (isWeekendShift) {
                       deferred.weekend.hours += 7.75;
                       deferred.weekend.pay += 7.75 * 3.25;
                    }
                }
            }
            
            // Rule: Straight Time Meal for External Escorts
            if (shift.hasEscort) {
                deferred.stm.hours += 1;
                deferred.stm.pay += 1 * baseRate;
            }
        });
    }
    
    return { regularPay: initialResult.regularPay, deferred, equivalentBankedOtHours };
};


// --- NEW HELPER FOR DB SETUP ---
const getDatabaseSetupSql = (): string => {
    return `
-- This script creates the required 'profiles' table and sets up security.
-- 1. Create the table to store user profile data.
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  email TEXT,
  profile JSONB,
  shifts JSONB,
  cashedouthours JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Enable Row Level Security (RLS) on the table.
-- This is a critical security measure in Supabase.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. Create a policy to control access.
-- This policy allows authenticated users to view and manage ONLY their own data.
CREATE POLICY "Users can manage their own profile data"
ON public.profiles
FOR ALL
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- 4. (Optional but recommended) Create a function to automatically update the 'updated_at' timestamp.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. (Optional but recommended) Create a trigger to call the function when a row is updated.
CREATE TRIGGER on_profile_updated
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();

-- 6. Add comments on the columns for clarity.
COMMENT ON TABLE public.profiles IS 'Stores user-specific data like profile settings and work shifts.';
COMMENT ON COLUMN public.profiles.id IS 'Links to the authenticated user in auth.users.';
    `.trim();
};

// --- APP COMPONENTS ---

const ConfigurationScreen = () => {
    return (
        <div className="auth-container">
            <div className="auth-box" style={{ maxWidth: '600px', textAlign: 'left' }}>
                <h1 style={{ textAlign: 'center' }}>Connect to Supabase</h1>
                <p style={{ textAlign: 'center' }}>
                    To get started, add your Supabase credentials to the application code.
                </p>

                <div className="config-instructions">
                    <p><strong>Step 1: Locate your Keys</strong></p>
                    <p style={{paddingBottom: '1rem'}}>
                        In your Supabase project dashboard, go to <strong>Project Settings</strong> (the gear icon) &rarr; <strong>API</strong>. You will find your Project URL and anon public key there.
                    </p>

                    <p><strong>Step 2: Update the Code</strong></p>
                    <p>
                        Open the <code>index.tsx</code> file and find the section labeled <code>--- Supabase Configuration ---</code> at the top.
                        Replace the placeholder values with your actual keys from Supabase:
                    </p>
                    <pre className="code-block">
                        <code>
                            {`// Replace these values with your actual Supabase credentials\nconst SUPABASE_URL_PLACEHOLDER = "https://your-project-id.supabase.co";\nconst SUPABASE_ANON_KEY_PLACEHOLDER = "your-anon-public-key-here";`}
                        </code>
                    </pre>

                    <p style={{marginTop: '1.5rem'}}><strong>Step 3: Run the App</strong></p>
                    <p>
                        Once you've replaced the placeholders with your real keys, run the application again.
                    </p>
                </div>
            </div>
        </div>
    );
};


interface ModalProps {
    children: React.ReactNode;
    isOpen: boolean;
    onClose: () => void;
    title: string;
}

const Modal = ({ children, isOpen, onClose, title }: ModalProps) => {
    useEffect(() => {
        if (isOpen) {
            document.body.classList.add('modal-open');
        } else {
            document.body.classList.remove('modal-open');
        }

        // Cleanup function to ensure the class is removed when the component unmounts
        return () => {
            document.body.classList.remove('modal-open');
        };
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>{title}</h3>
                    <button onClick={onClose} className="modal-close-btn">&times;</button>
                </div>
                <div className="modal-body">
                    {children}
                </div>
            </div>
        </div>
    );
};

const DatabaseSetupScreen = ({ sqlScript }: { sqlScript: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(sqlScript).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
        });
    }, [sqlScript]);

    const handleRetry = () => {
        window.location.reload();
    };

    return (
        <div className="auth-container">
            <div className="auth-box" style={{maxWidth: '700px', textAlign: 'left'}}>
                <h1 style={{textAlign: 'center'}}>Database Setup Required</h1>
                <p style={{textAlign: 'center'}}>The application is missing a required database table ('profiles'). Please run the following SQL script in your Supabase project's SQL Editor to create it.</p>
                
                <div className="sql-script-container">
                    <pre><code>{sqlScript}</code></pre>
                    <button onClick={handleCopy} className="copy-btn">
                        {copied ? 'Copied!' : 'Copy SQL'}
                    </button>
                </div>

                <p style={{marginTop: '1.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)'}}>
                    <strong>How to run this script:</strong>
                    <ol style={{paddingLeft: '1.5rem', marginTop: '0.5rem', lineHeight: 1.6}}>
                        <li>Navigate to your Supabase project dashboard.</li>
                        <li>In the left sidebar, click on the 'SQL Editor' icon.</li>
                        <li>Click '+ New query'.</li>
                        <li>Paste the copied script into the editor.</li>
                        <li>Click the 'RUN' button.</li>
                    </ol>
                </p>

                <button onClick={handleRetry} style={{width: '100%', marginTop: '1.5rem'}}>I've run the script, let's try again</button>
            </div>
        </div>
    );
};

const LoadingSpinner = () => (
    <div className="loading-spinner-overlay">
        <div className="loading-spinner"></div>
    </div>
);

const SavingSpinner = ({ message }: { message: string }) => (
    <div className="loading-spinner-overlay">
        <div className="saving-indicator">
            <div className="loading-spinner"></div>
            <p>{message}</p>
        </div>
    </div>
);

const AuthScreen = () => {
    const [view, setView] = useState('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [loading, setLoading] = useState(false);

    const resetForm = () => {
        setEmail('');
        setPassword('');
        setError('');
    };

    const handleViewChange = (newView: string) => {
        resetForm();
        setSuccess('');
        setView(newView);
    };

    const handleRegistrationSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setLoading(true);
        try {
            await api.register(email, password);
            setSuccess('Registration successful! Please check your email to confirm your account, then you can log in.');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const handleLoginSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const { error: loginError } = await api.login(email, password);
            if (loginError) {
                throw loginError;
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setLoading(true);
        try {
            await api.sendPasswordResetEmail(email);
            setSuccess('If an account for this email exists, a password reset link has been sent.');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const renderContent = () => {
        if (view === 'forgotPassword') {
            return (
                <>
                    <h1>Reset Password</h1>
                    <p>Enter your email to get a reset link.</p>
                    <form onSubmit={handleForgotPasswordSubmit}>
                        {error && <p className="auth-error">{error}</p>}
                        {success && <p className="auth-success">{success}</p>}
                        <div className="form-group"><label htmlFor="email">Email</label><input type="email" id="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                        <button type="submit" disabled={loading}>{loading ? 'Sending...' : 'Send Reset Link'}</button>
                    </form>
                    <p className="auth-toggle">Remember your password? <button onClick={() => handleViewChange('login')}>Back to Login</button></p>
                </>
            );
        }

        if (view === 'register') {
            return (
                <>
                    <h1>Register</h1>
                    <p>Create a new account</p>
                    <form onSubmit={handleRegistrationSubmit}>
                        {error && <p className="auth-error">{error}</p>}
                        {success && <p className="auth-success">{success}</p>}
                        <div className="form-group"><label htmlFor="email">Email</label><input type="email" id="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                        <div className="form-group"><label htmlFor="password">Password</label><input type="password" id="password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
                        <button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Account'}</button>
                    </form>
                    <p className="auth-toggle">Already have an account? <button onClick={() => handleViewChange('login')}>Login</button></p>
                </>
            );
        }

        return (
            <>
                <h1>Login</h1>
                <p>ACS Salary Calculator</p>
                <form onSubmit={handleLoginSubmit}>
                    {error && <p className="auth-error">{error}</p>}
                    {success && <p className="auth-success">{success}</p>}
                    <div className="form-group"><label htmlFor="email">Email</label><input type="email" id="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                    <div className="form-group"><label htmlFor="password">Password</label><input type="password" id="password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
                    <button type="submit" disabled={loading}>{loading ? 'Logging in...' : 'Login'}</button>
                </form>
                <p className="auth-toggle">Don't have an account? <button onClick={() => handleViewChange('register')}>Register</button></p>
                <p className="auth-toggle">Forgot your password? <button onClick={() => handleViewChange('forgotPassword')}>Reset it</button></p>
            </>
        );
    };

    return <div className="auth-container"><div className="auth-box">{renderContent()}</div></div>;
};

interface MobileHeaderProps { currentPage: string; onMenuClick: () => void; }
const MobileHeader = ({ currentPage, onMenuClick }: MobileHeaderProps) => {
    const pageTitle = currentPage.charAt(0).toUpperCase() + currentPage.slice(1);
    return (
        <div className="mobile-header">
            <button onClick={onMenuClick} className="hamburger-btn" aria-label="Open menu">
                <span></span>
                <span></span>
                <span></span>
            </button>
            <h2 className="mobile-page-title">{pageTitle}</h2>
        </div>
    );
};

interface ThemeToggleProps { theme: string; toggleTheme: () => void; }
const ThemeToggle = ({ theme, toggleTheme }: ThemeToggleProps) => (
    <button onClick={toggleTheme} className="theme-toggle-btn" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
    </button>
);

interface SidebarProps {
    currentPage: string;
    setPage: (page: string) => void;
    onLogout: () => void;
    isOpen: boolean;
    onClose: () => void;
    theme: string;
    toggleTheme: () => void;
}
const Sidebar = ({ currentPage, setPage, onLogout, isOpen, onClose, theme, toggleTheme }: SidebarProps) => (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        <div>
            <div className="sidebar-header">
                <h1>ACS Salary</h1>
                <button onClick={onClose} className="sidebar-close-btn">&times;</button>
            </div>
            <nav>
                <button className={currentPage === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}><DashboardIcon /> <span>Dashboard</span></button>
                <button className={currentPage === 'schedule' ? 'active' : ''} onClick={() => setPage('schedule')}><ScheduleIcon /> <span>Work Schedule</span></button>
                <button className={currentPage === 'ledger' ? 'active' : ''} onClick={() => setPage('ledger')}><LedgerIcon /> <span>Banked OT Ledger</span></button>
                <button className={currentPage === 'profile' ? 'active' : ''} onClick={() => setPage('profile')}><ProfileIcon /> <span>Profile</span></button>
            </nav>
        </div>
        <div className="sidebar-footer">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
            <button onClick={onLogout} className="logout-btn">Logout</button>
        </div>
    </aside>
);

interface ProfileProps {
    profile: ProfileData;
    onSave: (profile: ProfileData) => void;
    isSaving: boolean;
}
const Profile = React.memo(({ profile, onSave, isSaving }: ProfileProps) => {
    const defaultPattern: Array<'D' | 'A' | 'N' | 'O'> = ['A', 'A', 'A', 'D', 'D', 'D', 'O', 'O', 'O'];
    const [baseRate, setBaseRate] = useState(profile.baseRate);
    const [refDate, setRefDate] = useState(profile.workCycleReference?.date || toISODateString(new Date()));
    const [refDay, setRefDay] = useState(profile.workCycleReference?.day || 1);
    const [pattern, setPattern] = useState<Array<'D' | 'A' | 'N' | 'O'>>(profile.workCycleReference?.pattern || defaultPattern);


    useEffect(() => {
        setBaseRate(profile.baseRate);
        if (profile.workCycleReference) {
            setRefDate(profile.workCycleReference.date);
            setRefDay(profile.workCycleReference.day);
            setPattern(profile.workCycleReference.pattern || defaultPattern);
        }
    }, [profile]);

    const handlePatternChange = (index: number, value: 'D' | 'A' | 'N' | 'O') => {
        const newPattern = [...pattern];
        newPattern[index] = value;
        setPattern(newPattern);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave({ 
            baseRate: parseFloat(String(baseRate)) || 0,
            workCycleReference: { 
                date: refDate, 
                day: parseInt(String(refDay), 10),
                pattern: pattern 
            },
        });
    };

    return (
        <div>
            <div className="page-header"><h2>User Profile</h2></div>
            <form onSubmit={handleSubmit} className="profile-form">
              <div className="card">
                <div className="form-group">
                    <label htmlFor="baseRate">Hourly Base Rate ($)</label>
                    <input type="number" id="baseRate" value={baseRate} onChange={(e) => setBaseRate(Number(e.target.value))} step="0.01" required />
                </div>
              </div>

              <div className="card">
                <h3 className="card-header-title">Work Cycle Reference</h3>
                <p className="card-description">Set a single date that you know the cycle day for. This acts as an anchor for the schedule.</p>
                <div className="work-cycle-inputs">
                    <div className="form-group" style={{flex: 2}}>
                        <label htmlFor="refDate">Reference Date</label>
                        <input type="date" id="refDate" value={refDate} onChange={e => setRefDate(e.target.value)} required />
                    </div>
                     <span style={{marginBottom: '1.5rem'}}>is</span>
                    <div className="form-group" style={{flex: 3}}>
                        <label htmlFor="refDay">Day of Cycle</label>
                        <select id="refDay" value={refDay} onChange={e => setRefDay(parseInt(e.target.value, 10))} required>
                            {Array.from({ length: 9 }, (_, i) => i + 1).map(day => (
                                <option key={day} value={day}>
                                    Day {day}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
              </div>

              <div className="card">
                <h3 className="card-header-title">Work Cycle Pattern</h3>
                <p className="card-description">Define your personal 9-day work rotation pattern. This will be used as the default schedule.</p>
                <div className="work-cycle-pattern-grid">
                    {pattern.map((shiftType, index) => (
                        <div key={index} className="form-group">
                            <label htmlFor={`cycle-day-${index + 1}`}>Day {index + 1}</label>
                            <select 
                                id={`cycle-day-${index + 1}`} 
                                value={shiftType} 
                                onChange={e => handlePatternChange(index, e.target.value as 'D' | 'A' | 'N' | 'O')}
                            >
                                <option value="D">Day Shift</option>
                                <option value="A">Afternoon Shift</option>
                                <option value="N">Night Shift</option>
                                <option value="O">Off Day</option>
                            </select>
                        </div>
                    ))}
                </div>
              </div>

              <button type="submit" style={{marginTop: '1rem'}} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Profile Changes'}
              </button>
            </form>
        </div>
    );
});

interface WorkScheduleProps {
    profile: ProfileData;
    shifts: ShiftsData;
    onSaveShifts: (date: Date, newShifts: Shift[]) => void;
    payPeriods: PayPeriod[];
    allStatHolidays: Record<string, string>;
    isSaving: boolean;
}
const WorkSchedule = React.memo(({ profile, shifts, onSaveShifts, payPeriods, allStatHolidays, isSaving }: WorkScheduleProps) => {
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);

    const initialPayPeriodIndex = useMemo(() => getCurrentPayPeriodIndex(payPeriods), [payPeriods]);
    const [selectedYear, setSelectedYear] = useState(payPeriods[initialPayPeriodIndex].year);
    const [selectedPayPeriodInYear, setSelectedPayPeriodInYear] = useState(payPeriods[initialPayPeriodIndex].payPeriodOfYear);
    
    const availableYears = useMemo(() => [...new Set(payPeriods.map(p => p.year))], [payPeriods]);
    const payPeriodsForYear = useMemo(() => payPeriods.filter(p => p.year === selectedYear), [payPeriods, selectedYear]);

    useEffect(() => {
        const initialPayPeriod = payPeriods[initialPayPeriodIndex];
        const elementId = `pay-period-${initialPayPeriod.number}`;
        const element = document.getElementById(elementId);
        if (element) {
            setTimeout(() => element.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
        }
    }, [initialPayPeriodIndex, payPeriods]);

    const handleDayClick = (date: Date) => {
        setSelectedDate(date);
        setIsEditorOpen(true);
    };
    
    const handleEditorSave = (shiftsForDate: Shift[]) => {
        if (selectedDate) {
            onSaveShifts(selectedDate, shiftsForDate);
        }
        setIsEditorOpen(false);
    };

    const handleEditorClose = () => {
        setIsEditorOpen(false);
    };
    
    const handleNavigation = (year: number, ppInYear: number) => {
        const targetPeriod = payPeriods.find(p => p.year === year && p.payPeriodOfYear === ppInYear);
        if (targetPeriod) {
            const element = document.getElementById(`pay-period-${targetPeriod.number}`);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                element.style.transition = 'background-color 0.2s linear';
                element.style.backgroundColor = 'var(--background-tertiary)';
                setTimeout(() => { element.style.backgroundColor = ''; }, 1000);
            }
        }
    };

    const handleYearChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const year = parseInt(e.target.value, 10);
        const firstPp = 1;
        setSelectedYear(year);
        setSelectedPayPeriodInYear(firstPp);
        handleNavigation(year, firstPp);
    };

    const handlePayPeriodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const ppInYear = parseInt(e.target.value, 10);
        setSelectedPayPeriodInYear(ppInYear);
        handleNavigation(selectedYear, ppInYear);
    };

    return (
        <div>
            <div className="schedule-header">
                <h2>Work Schedule</h2>
                <div className="schedule-nav">
                    <label htmlFor="year-nav">Year</label>
                    <select id="year-nav" value={selectedYear} onChange={handleYearChange}>
                        {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                    <label htmlFor="pay-period-nav">Pay Period</label>
                     <select id="pay-period-nav" value={selectedPayPeriodInYear} onChange={handlePayPeriodChange}>
                        {payPeriodsForYear.map(pp => (
                            <option key={pp.payPeriodOfYear} value={pp.payPeriodOfYear}>
                                PP {pp.payPeriodOfYear} ({pp.start.toLocaleDateString()} - {pp.end.toLocaleDateString()})
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            {payPeriodsForYear.map(pp => (
                <div key={pp.number} id={`pay-period-${pp.number}`} className="pay-period-container">
                    <h3>Pay Period {pp.payPeriodOfYear} ({pp.year}) | {pp.start.toLocaleDateString()} - {pp.end.toLocaleDateString()}</h3>
                    <div className="calendar-weekday-header">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <div key={day} className="weekday">{day}</div>)}
                    </div>
                    <div className="calendar-grid">
                        {Array.from({ length: PAY_PERIOD_LENGTH_DAYS }).map((_, i) => {
                            const date = addDays(pp.start, i);
                            const effectiveShifts = getEffectiveShiftsForDate(date, shifts, profile);
                            const workCycleDay = getWorkCycleDayForDate(date, profile);
                            
                            const dayOfWeek = date.getDay();
                            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                            const isStatHoliday = !!allStatHolidays[toISODateString(date)];
                            
                            const dayClasses = ['calendar-day'];
                            if (isStatHoliday) dayClasses.push('is-stat-holiday');
                            else if (isWeekend) dayClasses.push('is-weekend');

                            return (
                                <div key={i} className={dayClasses.join(' ')} onClick={() => handleDayClick(date)}>
                                    <div className="day-header">
                                        <span className="day-number">{date.getDate()}</span>
                                        {isStatHoliday && <span className="stat-holiday-marker" title={allStatHolidays[toISODateString(date)]}>★</span>}
                                    </div>
                                    <div className="day-info">
                                        {effectiveShifts.map((shift, idx) => (
                                            <div key={idx} className={`shift-badge ${shift.type} ${shift.category !== 'Regular' ? 'is-overtime' : ''}`}>{shift.type}</div>
                                        ))}
                                    </div>
                                    <div className="day-footer">
                                        {workCycleDay && <span className="work-cycle-day">{getWorkCycleDayName(workCycleDay)}</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
            <Modal isOpen={isEditorOpen} onClose={handleEditorClose} title={`Edit Shifts for ${selectedDate?.toLocaleDateString()}`}>
                <ShiftEditor 
                    shiftsForDate={selectedDate ? getEffectiveShiftsForDate(selectedDate, shifts, profile) : []}
                    onClose={handleEditorClose}
                    onSave={handleEditorSave}
                    isSaving={isSaving}
                />
            </Modal>
        </div>
    );
});

interface ShiftEditorProps {
    shiftsForDate: Shift[];
    onClose: () => void;
    onSave: (shifts: Shift[]) => void;
    isSaving: boolean;
}
const ShiftEditor = ({ shiftsForDate, onClose, onSave, isSaving }: ShiftEditorProps) => {
    const [currentShifts, setCurrentShifts] = useState<Shift[]>([]);

    useEffect(() => {
        if (!shiftsForDate || shiftsForDate.length === 0) {
            setCurrentShifts([{ type: 'O', category: 'Regular', hasEscort: false, isBanked: false, isBookedOff: false }]);
        } else {
            setCurrentShifts(JSON.parse(JSON.stringify(shiftsForDate)));
        }
    }, [shiftsForDate]);

    const removeShift = (index: number) => {
        const remainingShifts = currentShifts.filter((_, i) => i !== index);
        if (remainingShifts.length === 0) {
            setCurrentShifts([{ type: 'O', category: 'Regular', hasEscort: false, isBanked: false, isBookedOff: false }]);
        } else {
            setCurrentShifts(remainingShifts);
        }
    };

    const handleShiftChange = (index: number, field: keyof Shift, value: any) => {
        // BUG FIX 1: When a shift's type is changed to 'O', it's removed, leaving other shifts untouched.
        if (field === 'type' && value === 'O') {
            removeShift(index);
            return;
        }

        const newShifts = [...currentShifts];
        const shiftToUpdate = { ...newShifts[index], [field]: value };

        // Logic: if changing category from 'Regular' on a placeholder 'Off' shift, it becomes a 'Day' shift.
        if (field === 'category' && newShifts[index].type === 'O' && value !== 'Regular') {
            shiftToUpdate.type = 'D';
        }

        // Logic: An overtime shift cannot be "booked off".
        if (shiftToUpdate.category !== 'Regular') {
            shiftToUpdate.isBookedOff = false;
        }

        newShifts[index] = shiftToUpdate;
        setCurrentShifts(newShifts);
    };

    const addShift = () => {
        // If the day is "Off", replace that state with the new shift. Otherwise, add to existing shifts.
        const baseShifts = currentShifts.length === 1 && currentShifts[0].type === 'O'
            ? []
            : currentShifts.filter(s => s.type !== 'O');

        // BUG FIX 2: Intelligently pick the default overtime category to avoid duplicates.
        const hasFirstOT = baseShifts.some(s => s.category === 'First Overtime');
        const defaultCategory = hasFirstOT ? 'Second Overtime' : 'First Overtime';
        
        setCurrentShifts([
            ...baseShifts,
            { type: 'D', category: defaultCategory, hasEscort: false, isBanked: false, isBookedOff: false }
        ]);
    };

    const handleSave = () => {
        const shiftsToSave = currentShifts.filter(shift => shift.type !== 'O');
        onSave(shiftsToSave);
    };
    
    // Render logic
    const isDayCurrentlyOff = currentShifts.length === 1 && currentShifts[0].type === 'O';
    const canAddMoreShifts = currentShifts.filter(s => s.type !== 'O').length < 2;

    return (
        <div className="shift-editor-wrapper">
            {isDayCurrentlyOff ? (
                 <div className="shift-editor-item">
                    <p>This day is scheduled as 'Off'.</p>
                    <p className="card-description">Add a shift to record work, or close to keep as is.</p>
                </div>
            ) : currentShifts.map((shift, index) => {
                if (shift.type === 'O') return null;

                const shiftTitle = shift.category === 'Regular' ? 'Regular Shift' : shift.category;
                const isAnotherRegularShiftPresent = currentShifts.some((s, i) => i !== index && s.category === 'Regular');

                return (
                    <div key={index} className="shift-editor-item">
                        <div className="shift-editor-header">
                            <h4>{shiftTitle}</h4>
                            <button onClick={() => removeShift(index)} className="remove-shift-btn">Remove</button>
                        </div>
                         <div className="form-group">
                           <label htmlFor={`shift-category-${index}`}>Category</label>
                           <select 
                                id={`shift-category-${index}`} 
                                value={shift.category} 
                                onChange={e => handleShiftChange(index, 'category', e.target.value as Shift['category'])}
                                disabled={isAnotherRegularShiftPresent && shift.category !== 'Regular'}
                            >
                               <option value="Regular">Regular</option>
                               <option value="First Overtime">First Overtime</option>
                               <option value="Second Overtime">Second Overtime</option>
                           </select>
                           {isAnotherRegularShiftPresent && shift.category !== 'Regular' && <p className="checkbox-note">Only one Regular shift is allowed.</p>}
                        </div>
                        <div className="form-group">
                           <label htmlFor={`shift-type-${index}`}>Shift Type</label>
                           <select 
                                id={`shift-type-${index}`} 
                                value={shift.type} 
                                onChange={e => handleShiftChange(index, 'type', e.target.value as Shift['type'])}
                            >
                               <option value="D">Day Shift</option>
                               <option value="A">Afternoon Shift</option>
                               <option value="N">Night Shift</option>
                               <option value="O">Off / Clear Shift</option>
                           </select>
                           {shift.category !== 'Regular' && <p className="checkbox-note">Type for OT is informational; pay is based on the day's regular shift.</p>}
                        </div>
                        <div className="checkbox-group">
                           <input type="checkbox" id={`has-escort-${index}`} checked={shift.hasEscort} onChange={e => handleShiftChange(index, 'hasEscort', e.target.checked)} />
                           <label htmlFor={`has-escort-${index}`}>External Escort (STM)</label>
                        </div>
                         {shift.category === 'Regular' ? (
                            <>
                                <div className="checkbox-group">
                                    <input type="checkbox" id={`is-booked-off-${index}`} checked={shift.isBookedOff} onChange={e => handleShiftChange(index, 'isBookedOff', e.target.checked)} />
                                    <label htmlFor={`is-booked-off-${index}`}>Booked Off (e.g. sick, vacation)</label>
                                </div>
                                 <p className="checkbox-note">Removes premiums for this shift.</p>
                             </>
                         ) : (
                            <>
                                <div className="checkbox-group">
                                    <input type="checkbox" id={`is-banked-${index}`} checked={shift.isBanked} onChange={e => handleShiftChange(index, 'isBanked', e.target.checked)} />
                                    <label htmlFor={`is-banked-${index}`}>Bank This Overtime</label>
                                </div>
                            </>
                        )}
                    </div>
                );
            })}
            <div className="editor-footer">
                <button onClick={onClose} className="cancel-btn">Cancel</button>
                <div style={{display: 'flex', gap: '0.5rem'}}>
                    {canAddMoreShifts && <button onClick={addShift} className="secondary-btn">Add Overtime</button>}
                    <button onClick={handleSave} className="save-btn" disabled={isSaving || currentShifts.length === 0}>
                        {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface DashboardProps {
    profile: ProfileData | null;
    shifts: ShiftsData;
    cashedOutHours: CashedOutHoursData;
    onSaveCashedOutHours: (year: number, ppNumber: number, hours: number) => void;
    payPeriods: PayPeriod[];
    allStatHolidays: Record<string, string>;
}
const Dashboard = ({ profile, shifts, cashedOutHours, onSaveCashedOutHours, payPeriods, allStatHolidays }: DashboardProps) => {
    const initialPayPeriodIndex = useMemo(() => getCurrentPayPeriodIndex(payPeriods), [payPeriods]);
    
    const [selectedPayPeriodIndex, setSelectedPayPeriodIndex] = useState(initialPayPeriodIndex);
    const [viewMode, setViewMode] = useState<'paycheck' | 'projection'>('paycheck');
    
    const selectedPayPeriod = payPeriods[selectedPayPeriodIndex];
    const previousPayPeriod = selectedPayPeriodIndex > 0 ? payPeriods[selectedPayPeriodIndex - 1] : null;

    const currentCalculation = useMemo(() => {
        if (!profile) return null;
        return calculateSalaryForPayPeriod(selectedPayPeriod, shifts, profile, allStatHolidays);
    }, [selectedPayPeriod, shifts, profile, allStatHolidays]);
    
    const previousCalculation = useMemo(() => {
        if (!profile || !previousPayPeriod) return null;
        return calculateSalaryForPayPeriod(previousPayPeriod, shifts, profile, allStatHolidays);
    }, [previousPayPeriod, shifts, profile, allStatHolidays]);

    const ledgerData = useMemo(() => {
        if (!profile?.baseRate || profile.baseRate <= 0) return [];
        
        let bankBalance = 0;
        
        const sortedPayPeriods = [...payPeriods].sort((a, b) => a.number - b.number);
        
        return sortedPayPeriods.map(pp => {
            const startBalance = bankBalance;
            const cashedOut = cashedOutHours[pp.number] || 0;
            const calculation = calculateSalaryForPayPeriod(pp, shifts, profile, allStatHolidays);
            
            if (!calculation) return null;

            bankBalance += calculation.equivalentBankedOtHours;
            bankBalance -= cashedOut;
            
            return {
                globalPPNumber: pp.number,
                startBalance: startBalance,
                endBalance: bankBalance,
            };
        }).filter(Boolean) as { globalPPNumber: number; startBalance: number; endBalance: number; }[];
    }, [profile, shifts, cashedOutHours, payPeriods, allStatHolidays]);

    const selectedLedgerEntry = ledgerData.find(entry => entry.globalPPNumber === selectedPayPeriod.number);

    const handlePayPeriodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedPayPeriodIndex(parseInt(e.target.value, 10));
    };
    
    const goToPrevious = () => setSelectedPayPeriodIndex(prev => Math.max(0, prev - 1));
    const goToNext = () => setSelectedPayPeriodIndex(prev => Math.min(payPeriods.length - 1, prev + 1));
    
    if (!profile?.baseRate || profile.baseRate <= 0) {
        return (
            <div className="card">
                <h2>Welcome to the Dashboard</h2>
                <p>Please set your hourly base rate in your Profile to calculate your pay.</p>
            </div>
        );
    }

    return (
        <div>
            <div className="dashboard-tabs">
                <button 
                    className={viewMode === 'paycheck' ? 'active' : ''}
                    onClick={() => setViewMode('paycheck')}>
                    Pay Period Details
                </button>
                <button 
                    className={viewMode === 'projection' ? 'active' : ''}
                    onClick={() => setViewMode('projection')}>
                    Annual Projection
                </button>
            </div>

            {viewMode === 'paycheck' ? (
                <>
                    <div className="dashboard-controls">
                        <button onClick={goToPrevious} disabled={selectedPayPeriodIndex === 0}>&larr; Previous</button>
                        <div className="pay-period-selectors">
                            <select value={selectedPayPeriod.year} onChange={(e) => {
                                const newYear = parseInt(e.target.value, 10);
                                const firstIndexOfYear = payPeriods.findIndex(p => p.year === newYear);
                                setSelectedPayPeriodIndex(firstIndexOfYear);
                            }}>
                                {[...new Set(payPeriods.map(p => p.year))].map(year => (
                                    <option key={year} value={year}>{year}</option>
                                ))}
                            </select>
                            <select value={selectedPayPeriodIndex} onChange={handlePayPeriodChange}>
                                {payPeriods.filter(p => p.year === selectedPayPeriod.year).map(pp => {
                                    const ppIndex = payPeriods.findIndex(p => p.number === pp.number);
                                    return (
                                        <option key={pp.number} value={ppIndex}>
                                            PP {pp.payPeriodOfYear}: {pp.start.toLocaleDateString()} - {pp.end.toLocaleDateString()}
                                        </option>
                                    )
                                })}
                            </select>
                        </div>
                        <button onClick={goToNext} disabled={selectedPayPeriodIndex === payPeriods.length - 1}>Next &rarr;</button>
                    </div>
                    <PayPeriodDetailView 
                        payPeriod={selectedPayPeriod}
                        previousPayPeriod={previousPayPeriod}
                        profile={profile}
                        cashedOutHours={cashedOutHours[selectedPayPeriod.number] || 0}
                        onSaveCashedOutHours={(hours) => onSaveCashedOutHours(selectedPayPeriod.year, selectedPayPeriod.payPeriodOfYear, hours)}
                        currentCalculation={currentCalculation}
                        previousCalculation={previousCalculation}
                        bankSummary={selectedLedgerEntry ? { startBalance: selectedLedgerEntry.startBalance, endBalance: selectedLedgerEntry.endBalance } : null}
                    />
                </>
            ) : (
                <AnnualProjectionView 
                    payPeriods={payPeriods}
                    profile={profile}
                    shifts={shifts}
                    allStatHolidays={allStatHolidays}
                />
            )}
        </div>
    );
};


interface PayPeriodDetailViewProps {
    payPeriod: PayPeriod;
    previousPayPeriod: PayPeriod | null;
    profile: ProfileData;
    cashedOutHours: number;
    onSaveCashedOutHours: (hours: number) => void;
    currentCalculation: SalaryCalculationResult | null;
    previousCalculation: SalaryCalculationResult | null;
    bankSummary: { startBalance: number; endBalance: number; } | null;
}
const PayPeriodDetailView = ({ payPeriod, previousPayPeriod, profile, cashedOutHours, onSaveCashedOutHours, currentCalculation, previousCalculation, bankSummary }: PayPeriodDetailViewProps) => {
    const printableRef = useRef<HTMLDivElement>(null);
    const [isPrinting, setIsPrinting] = useState(false);

    const handleDownloadPdf = async () => {
        if (!printableRef.current || !currentCalculation) return;
        setIsPrinting(true);
        try {
            const canvas = await html2canvas(printableRef.current, { scale: 2 });
            const imgData = canvas.toDataURL('image/png');
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(`Paystub-PP${payPeriod.payPeriodOfYear}-${payPeriod.year}.pdf`);
        } catch (error) {
            console.error("Error generating PDF:", error);
        } finally {
            setIsPrinting(false);
        }
    };
    
    if (!currentCalculation || !profile) return null;
    
    const previousDeferredTotal = previousCalculation ? Object.values(previousCalculation.deferred).reduce((sum, item) => sum + item.pay, 0) : 0;
    const currentDeferredTotal = Object.values(currentCalculation.deferred).reduce((sum, item) => sum + item.pay, 0);
    const totalGrossPay = currentCalculation.regularPay.pay + previousDeferredTotal;
    
    return (
        <>
            <div className="dashboard-grid">
                <div className="card">
                    <div className="dashboard-card-header">
                        <h3>Paycheck for PP {payPeriod.payPeriodOfYear} ({payPeriod.year})</h3>
                        <button className="pdf-download-btn" onClick={handleDownloadPdf} disabled={isPrinting}>
                            <DownloadIcon />
                            {isPrinting ? 'Generating...' : 'Download Statement'}
                        </button>
                    </div>
                     <div className="paycheck-hero">
                        <span className="paycheck-hero-label">Estimated Gross Pay on Paycheck</span>
                        <span className="paycheck-hero-amount">${totalGrossPay.toFixed(2)}</span>
                    </div>

                    <div className="card-item">
                        <span>Base Salary (Current Period)</span>
                        <span>${currentCalculation.regularPay.pay.toFixed(2)}</span>
                    </div>
                     <div className="card-item">
                        <span>Deferred Pay (from PP {previousPayPeriod ? previousPayPeriod.payPeriodOfYear : 'N/A'})</span>
                        <span>${previousDeferredTotal.toFixed(2)}</span>
                    </div>

                    {previousDeferredTotal > 0 && previousCalculation && (
                        <div className="deferred-breakdown-list">
                            {Object.entries(previousCalculation.deferred).map(([key, value]) => value.pay > 0 && (
                                <div className="card-item" key={key}>
                                    <span>
                                        {key.replace(/_/g, ' ').replace('ot1 5x', 'OT 1.5x').replace('ot2x', 'OT 2.0x').replace(/\b\w/g, l => l.toUpperCase())}
                                        <span className="item-details">{value.hours.toFixed(2)} hrs</span>
                                    </span>
                                    <span>+ ${value.pay.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="card">
                    <h3>Current Period Activity</h3>
                    <div className="card-item">
                        <span>Deferred to Next Pay Period</span>
                        <span style={{fontWeight: 'bold'}}>${currentDeferredTotal.toFixed(2)}</span>
                    </div>
                     {currentDeferredTotal > 0 && (
                        <div className="deferred-breakdown-list">
                            {Object.entries(currentCalculation.deferred).map(([key, value]) => value.pay > 0 && (
                               <div className="card-item" key={key}>
                                   <span>
                                       {key.replace(/_/g, ' ').replace('ot1 5x', 'OT 1.5x').replace('ot2x', 'OT 2.0x').replace(/\b\w/g, l => l.toUpperCase())}
                                       <span className="item-details">{value.hours.toFixed(2)} hrs</span>
                                   </span>
                                   <span>+ ${value.pay.toFixed(2)}</span>
                               </div>
                           ))}
                        </div>
                    )}
                    
                    <h4 className="card-subtitle" style={{marginTop: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem'}}>Banked Overtime</h4>
                    <div className="card-item" style={{border: 'none'}}>
                        <span>Hours Banked This Period</span>
                        <span>{currentCalculation.equivalentBankedOtHours.toFixed(2)} hrs</span>
                    </div>
                    <div className="card-input-item">
                        <label htmlFor="cashed-out-hours">Cashed Out Hours</label>
                        <input
                            type="number"
                            id="cashed-out-hours"
                            value={cashedOutHours}
                            onChange={(e) => onSaveCashedOutHours(parseFloat(e.target.value) || 0)}
                            placeholder="0"
                        />
                    </div>
                    <p className="card-input-note">Enter hours cashed out from your bank this pay period.</p>
                </div>
            </div>
             <div className="printable-area-container">
                <PrintablePaystub 
                    ref={printableRef} 
                    payPeriod={payPeriod} 
                    calculationResult={currentCalculation} 
                    previousCalculationResult={previousCalculation}
                    profile={profile} 
                    cashedOutHours={cashedOutHours} 
                    bankSummary={bankSummary}
                />
            </div>
        </>
    );
};


interface AnnualProjectionViewProps {
    payPeriods: PayPeriod[];
    profile: ProfileData;
    shifts: ShiftsData;
    allStatHolidays: Record<string, string>;
}
const BarChart = ({ data }: { data: { name: string; value: number }[] }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const height = 400;

    useEffect(() => {
        if (containerRef.current) {
            const resizeObserver = new ResizeObserver(entries => {
                if (entries[0]) {
                    setWidth(entries[0].contentRect.width);
                }
            });
            resizeObserver.observe(containerRef.current);
            return () => resizeObserver.disconnect();
        }
    }, []);

    if (width === 0 || data.length === 0) {
        return <div ref={containerRef} style={{ width: '100%', height: `${height}px` }} />;
    }

    const margin = { top: 40, right: 20, bottom: 120, left: 70 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const maxValue = Math.max(...data.map(d => d.value));
    
    const barWidth = Math.max(10, (chartWidth / data.length) * 0.7);
    const barSpacing = chartWidth / data.length;

    const colors = ['#54a0ff', '#ff9f43', '#9c88ff', '#c8a2c8', '#0a84ff', '#ff6b6b', '#2e7d32', '#fd7e14'];

    const yTicks = 5;
    const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => (maxValue / yTicks) * i);

    return (
        <div ref={containerRef} style={{ width: '100%', height: `${height}px`, overflow: 'visible' }}>
            <svg width={width} height={height} style={{ overflow: 'visible' }}>
                <g className="y-axis">
                    {yTickValues.map((tick, i) => (
                        <g key={i} className="tick">
                            <line
                                x1={margin.left} y1={margin.top + chartHeight - (tick / maxValue) * chartHeight}
                                x2={margin.left - 6} y2={margin.top + chartHeight - (tick / maxValue) * chartHeight}
                                stroke="var(--border-color)"
                            />
                            <text
                                x={margin.left - 8}
                                y={margin.top + chartHeight - (tick / maxValue) * chartHeight}
                                textAnchor="end"
                                dy="0.32em"
                                fill="var(--text-secondary)"
                                fontSize="11"
                            >
                                ${tick.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </text>
                        </g>
                    ))}
                    <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + chartHeight} stroke="var(--border-color)"/>
                </g>
                <g className="x-axis">
                    <line x1={margin.left} y1={margin.top + chartHeight} x2={margin.left + chartWidth} y2={margin.top + chartHeight} stroke="var(--border-color)"/>
                </g>
                {data.map((d, i) => {
                    const barHeight = chartHeight * (d.value / maxValue);
                    if (barHeight <= 0) return null;
                    const x = margin.left + i * barSpacing + (barSpacing - barWidth) / 2;
                    const y = margin.top + chartHeight - barHeight;
                    return (
                        <g key={d.name} className="bar">
                            <title>{`${d.name}: $${d.value.toFixed(2)}`}</title>
                            <rect
                                x={x}
                                y={y}
                                width={barWidth}
                                height={barHeight}
                                fill={colors[i % colors.length]}
                            />
                            <text
                                x={x + barWidth / 2}
                                y={y - 8}
                                textAnchor="middle"
                                className="bar-value-label"
                            >
                                ${Math.round(d.value).toLocaleString()}
                            </text>
                            <text
                                x={x + barWidth / 2}
                                y={margin.top + chartHeight + 15}
                                textAnchor="end"
                                transform={`rotate(-45, ${x + barWidth / 2}, ${margin.top + chartHeight + 15})`}
                                className="bar-label"
                            >
                                {d.name}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
};
const AnnualProjectionView = ({ payPeriods, profile, shifts, allStatHolidays }: AnnualProjectionViewProps) => {
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [viewType, setViewType] = useState<'chart' | 'list'>('chart');
    
    const availableYears = useMemo(() => [...new Set(payPeriods.map(p => p.year))], [payPeriods]);

    const annualData = useMemo(() => {
        if (!profile) return null;

        const yearPayPeriods = payPeriods.filter(p => p.year === selectedYear);
        const projection: AnnualProjectionData = {
            year: selectedYear,
            totalGrossPay: 0,
            breakdown: {
                baseSalary: { hours: 0, pay: 0 },
                ot1_5x: { hours: 0, pay: 0 },
                ot2x: { hours: 0, pay: 0 },
                afternoon: { hours: 0, pay: 0 },
                night: { hours: 0, pay: 0 },
                weekend: { hours: 0, pay: 0 },
                stm: { hours: 0, pay: 0 },
                statHolidayBonus: { hours: 0, pay: 0 },
            }
        };

        yearPayPeriods.forEach(pp => {
            const result = calculateSalaryForPayPeriod(pp, shifts, profile, allStatHolidays);
            if (!result) return;
            
            projection.breakdown.baseSalary.pay += result.regularPay.pay;
            projection.breakdown.baseSalary.hours += result.regularPay.hours;

            for (const key in result.deferred) {
                const typedKey = key as keyof DeferredPay;
                projection.breakdown[typedKey].pay += result.deferred[typedKey].pay;
                projection.breakdown[typedKey].hours += result.deferred[typedKey].hours;
            }
        });
        
        projection.totalGrossPay = Object.values(projection.breakdown).reduce((sum, item) => sum + item.pay, 0);

        return projection;
    }, [selectedYear, payPeriods, profile, shifts, allStatHolidays]);

    if (!annualData) return null;
    
    const chartData = Object.entries(annualData.breakdown)
      .map(([name, data]) => ({ name: name.replace(/_/g, ' ').replace('baseSalary', 'Base Salary').replace('ot1 5x', 'OT 1.5x').replace('ot2x', 'OT 2.0x').replace('stm', 'STM').replace('statHolidayBonus', 'Stat Bonus').replace(/\b\w/g, l => l.toUpperCase()), value: data.pay }))
      .filter(d => d.value > 0)
      .sort((a,b) => b.value - a.value);

    return (
        <div className="card card-full-width">
            <div className="dashboard-card-header">
                <h3>Annual Projection for {selectedYear}</h3>
                <div style={{display: 'flex', gap: '1rem', alignItems: 'center'}}>
                    <select value={selectedYear} onChange={e => setSelectedYear(parseInt(e.target.value, 10))}>
                        {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                    <div className="view-switcher">
                        <button className={viewType === 'chart' ? 'active' : ''} onClick={() => setViewType('chart')}><BarChartIcon/> Chart</button>
                        <button className={viewType === 'list' ? 'active' : ''} onClick={() => setViewType('list')}><ListIcon /> List</button>
                    </div>
                </div>
            </div>

            <div className="paycheck-hero">
                <span className="paycheck-hero-label">Projected Total Gross Pay for {selectedYear}</span>
                <span className="paycheck-hero-amount">${annualData.totalGrossPay.toFixed(2)}</span>
            </div>

            {viewType === 'list' ? (
                <div>
                    {chartData.map(item => (
                        <div key={item.name} className="card-item">
                            <span>{item.name}</span>
                            <span>${item.value.toFixed(2)}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="annual-chart-container">
                    <BarChart data={chartData} />
                </div>
            )}
        </div>
    );
};


interface LedgerProps {
    profile: ProfileData | null;
    shifts: ShiftsData;
    cashedOutHours: CashedOutHoursData;
    payPeriods: PayPeriod[];
    allStatHolidays: Record<string, string>;
}
const Ledger = ({ profile, shifts, cashedOutHours, payPeriods, allStatHolidays }: LedgerProps) => {
    const ledgerData = useMemo(() => {
        if (!profile?.baseRate || profile.baseRate <= 0) return [];
        
        let bankBalance = 0;
        let ytdGross = 0;
        
        const sortedPayPeriods = [...payPeriods].sort((a, b) => a.number - b.number);
        
        return sortedPayPeriods.map(pp => {
            const startBalance = bankBalance;
            const cashedOut = cashedOutHours[pp.number] || 0;
            const calculation = calculateSalaryForPayPeriod(pp, shifts, profile, allStatHolidays);
            
            if (!calculation) return null;

            bankBalance += calculation.equivalentBankedOtHours;
            bankBalance -= cashedOut;

            const totalDeferredPay = Object.values(calculation.deferred).reduce((sum, item) => sum + item.pay, 0);
            const grossPay = calculation.regularPay.pay + totalDeferredPay;
            ytdGross += grossPay;
            
            return {
                ppNumber: pp.payPeriodOfYear,
                year: pp.year,
                globalPPNumber: pp.number,
                data: calculation,
                cashedOut: cashedOut,
                startBalance: startBalance,
                endBalance: bankBalance,
                grossPay,
                ytdGross
            };
        }).filter(Boolean) as LedgerEntry[];
    }, [profile, shifts, cashedOutHours, payPeriods, allStatHolidays]);

    if (!profile?.baseRate || profile.baseRate <= 0) {
        return (
            <div>
                <div className="page-header"><h2>Banked OT Ledger</h2></div>
                <div className="card">
                    <p>Please set your hourly base rate in your Profile to view the ledger.</p>
                </div>
            </div>
        );
    }
    
    return (
        <div>
            <div className="page-header"><h2>Banked OT Ledger</h2></div>
            <div className="card">
                <div className="ledger-table">
                    <div className="ledger-row ledger-header">
                        <span>Pay Period</span>
                        <span style={{textAlign: 'right'}}>Start Balance</span>
                        <span style={{textAlign: 'right'}}>Banked</span>
                        <span style={{textAlign: 'right'}}>Cashed Out</span>
                        <span style={{textAlign: 'right'}}>End Balance</span>
                    </div>
                    <div className="ledger-body full-page">
                        {ledgerData.map(entry => (
                            <div key={entry.globalPPNumber} className="ledger-row">
                                <span data-label="Pay Period">{entry.year} - PP {entry.ppNumber}</span>
                                <span data-label="Start Balance">{entry.startBalance.toFixed(2)} hrs</span>
                                <span data-label="Banked" className="added">+ {entry.data.equivalentBankedOtHours.toFixed(2)} hrs</span>
                                <span data-label="Cashed Out" className="removed">- {entry.cashedOut.toFixed(2)} hrs</span>
                                <span data-label="End Balance">{entry.endBalance.toFixed(2)} hrs</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};


interface PrintablePaystubProps {
    payPeriod: PayPeriod;
    calculationResult: SalaryCalculationResult | null;
    previousCalculationResult: SalaryCalculationResult | null;
    profile: ProfileData | null;
    cashedOutHours: number;
    bankSummary: { startBalance: number; endBalance: number; } | null;
}
const PrintablePaystub = React.forwardRef<HTMLDivElement, PrintablePaystubProps>(({ payPeriod, calculationResult, previousCalculationResult, profile, cashedOutHours, bankSummary }, ref) => {
    if (!calculationResult || !profile) {
        return null;
    }
    // Destructure current period's calculation results
    const { regularPay, deferred: deferredPayToNext, equivalentBankedOtHours } = calculationResult;

    // Calculate earnings from previous period's deferred pay
    const deferredPayFromPrevious = previousCalculationResult ? previousCalculationResult.deferred : null;
    const totalDeferredFromPrevious = deferredPayFromPrevious ? Object.values(deferredPayFromPrevious).reduce((sum, item) => sum + item.pay, 0) : 0;
    const totalGrossPay = regularPay.pay + totalDeferredFromPrevious;

    // Calculate total deferred pay from the current period
    const totalDeferredToNext = Object.values(deferredPayToNext).reduce((sum, item) => sum + item.pay, 0);

    return (
        <div ref={ref} className="printable-area">
            <div className="stub-header">
                <h1>Pay Statement</h1>
                <p>
                    <strong>Pay Period:</strong> {payPeriod.payPeriodOfYear} ({payPeriod.year})<br />
                    <strong>Period Dates:</strong> {payPeriod.start.toLocaleDateString()} to {payPeriod.end.toLocaleDateString()}<br />
                    <strong>Pay Date:</strong> {payPeriod.end.toLocaleDateString()}
                </p>
            </div>
            <div className="stub-main-content">
                <div className="stub-column">
                    <h3 className="stub-section-title">Earnings (Paid this Period)</h3>
                    <table className="stub-table">
                        <tbody>
                            <tr><td>Base Salary</td><td>${regularPay.pay.toFixed(2)}</td></tr>
                             {deferredPayFromPrevious && Object.entries(deferredPayFromPrevious).map(([key, value]) => value.pay > 0 && (
                                <tr key={key}>
                                    <td>
                                        {key.replace(/_/g, ' ').replace('ot1 5x', 'OT 1.5x').replace('ot2x', 'OT 2.0x').replace(/\b\w/g, l => l.toUpperCase())}
                                        <span className="detail-line">{value.hours.toFixed(2)} hrs</span>
                                    </td>
                                    <td>${value.pay.toFixed(2)}</td>
                                </tr>
                            ))}
                            <tr className="total-row"><td>Gross Pay</td><td>${totalGrossPay.toFixed(2)}</td></tr>
                        </tbody>
                    </table>
                </div>
                <div className="stub-column">
                    <h3 className="stub-section-title">Banked Overtime Summary</h3>
                     <table className="stub-table">
                        <tbody>
                            {bankSummary && <tr><td>Start Balance</td><td>{bankSummary.startBalance.toFixed(2)} hrs</td></tr>}
                            <tr><td>Hours Banked</td><td>{equivalentBankedOtHours.toFixed(2)} hrs</td></tr>
                            <tr><td>Hours Cashed Out</td><td>({cashedOutHours.toFixed(2)} hrs)</td></tr>
                            {bankSummary && <tr className="total-row"><td>End Balance</td><td>{bankSummary.endBalance.toFixed(2)} hrs</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Section for Deferred Pay to Next Period */}
            {totalDeferredToNext > 0 && (
                 <div>
                    <h3 className="stub-section-title">Deferred to Next Pay Period</h3>
                    <table className="stub-table">
                        <tbody>
                            {Object.entries(deferredPayToNext).map(([key, value]) => value.pay > 0 && (
                                <tr key={key}>
                                    <td>
                                        {key.replace(/_/g, ' ').replace('ot1 5x', 'OT 1.5x').replace('ot2x', 'OT 2.0x').replace(/\b\w/g, l => l.toUpperCase())}
                                        <span className="detail-line">{value.hours.toFixed(2)} hrs</span>
                                    </td>
                                    <td>${value.pay.toFixed(2)}</td>
                                </tr>
                            ))}
                            <tr className="total-row"><td>Total Deferred</td><td>${totalDeferredToNext.toFixed(2)}</td></tr>
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
});


const App = () => {
    const [session, setSession] = useState<Session | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [shifts, setShifts] = useState<ShiftsData>({});
    const [cashedOutHours, setCashedOutHours] = useState<CashedOutHoursData>({});
    const [loading, setLoading] = useState(true);
    const [dbError, setDbError] = useState<string | null>(null);
    const [isSavingData, setIsSavingData] = useState(false);
    const [savingMessage, setSavingMessage] = useState('Saving...');

    const [currentPage, setPage] = useState('dashboard');
    const [isSidebarOpen, setSidebarOpen] = useState(false);
    const [theme, setTheme] = useState(() => localStorage.getItem("acs-salary-theme") || "dark");
    
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('acs-salary-theme', theme);
    }, [theme]);
    
    const toggleTheme = () => setTheme(prev => prev === "dark" ? "light" : "dark");

    // Pay Period and Stat Holiday calculations
    const { payPeriods, allStatHolidays } = useMemo(() => {
        const periods: PayPeriod[] = [];
        const holidays: Record<string, string> = {};
        const currentYear = new Date().getFullYear();
        
        for (let year = currentYear - 1; year <= currentYear + 2; year++) {
            Object.assign(holidays, getStatHolidaysForYear(year));
        }

        const PAY_PERIODS_PER_YEAR = 26;

        // The loop generates 78 pay periods (3 financial years), same as the previous implementation
        // to ensure stability of the unique `number` key for each pay period.
        for (let i = -26; i < 52; i++) {
            // `i` is the number of pay periods relative to the start of FY 2025.
            // i=0 corresponds to the pay period starting on BASE_PAY_PERIOD_START_DATE.
            const start = addDays(BASE_PAY_PERIOD_START_DATE, i * PAY_PERIOD_LENGTH_DAYS);
            const end = addDays(start, PAY_PERIOD_LENGTH_DAYS - 1);

            // Calculate financial year based on the definition that FY2025 starts on BASE_PAY_PERIOD_START_DATE.
            const financialYear = 2025 + Math.floor(i / PAY_PERIODS_PER_YEAR);
            
            // Calculate pay period number within that financial year (1-26).
            // The formula handles negative `i` values correctly.
            const payPeriodOfYear = (i % PAY_PERIODS_PER_YEAR + PAY_PERIODS_PER_YEAR) % PAY_PERIODS_PER_YEAR + 1;
            
            periods.push({
                number: i + 27, // Preserves original numbering scheme for data consistency.
                payPeriodOfYear: payPeriodOfYear,
                year: financialYear, // The financial year
                start: start,
                end: end
            });
        }
        return { payPeriods: periods, allStatHolidays: holidays };
    }, []);

    const handleLogout = async () => {
        await api.logout();
        setPage('dashboard');
    };

    useEffect(() => {
        if (!isSupabaseConfigured) {
            setLoading(false);
            return;
        }

        const checkUser = async () => {
            setLoading(true);
            try {
                const { data: { session: currentSession } } = await supabase.auth.getSession();
                setSession(currentSession);

                if (currentSession?.user) {
                    const userData = await api.getUserData(currentSession.user.id);
                    setUser({ uid: currentSession.user.id, ...userData });
                    setProfile(userData.profile);
                    setShifts(userData.shifts || {});
                    setCashedOutHours(userData.cashedOutHours || {});
                }
            } catch (error: any) {
                // The error code for a missing table in Postgres is '42P01'.
                const isMissingTableError = error.code === '42P01' || (error.message && error.message.includes('relation "public.profiles" does not exist'));

                if (isMissingTableError) {
                    setDbError('missing_table');
                } else {
                    // Any other error indicates a critical failure in loading the user's data.
                    // To prevent the app from running in a broken state, we log the error and log out the user.
                    // This matches the behavior reported in the error log.
                    console.error("Error fetching profile:", error);
                    console.error("Logging out due to data fetch failure:", error);
                    handleLogout();
                }
            } finally {
                setLoading(false);
            }
        };

        checkUser();

        const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            // If the session is gone, clear all user data.
            if (!session) {
                setUser(null);
                setProfile(null);
                setShifts({});
                setCashedOutHours({});
                setLoading(false);
            } else if (session?.user && user?.uid !== session.user.id) {
                // If a new user logs in, re-run the check.
                 checkUser();
            }
        });

        return () => {
            authListener.subscription.unsubscribe();
        };
    }, []); // Run only on initial mount.


    const handleSaveProfile = async (newProfile: ProfileData) => {
        if (!user) return;
        setIsSavingData(true);
        setSavingMessage('Saving profile...');
        setProfile(newProfile);
        try {
            await api.saveUserData(user.uid, { profile: newProfile });
        } catch (error) {
            console.error("Failed to save profile:", error);
        } finally {
            setIsSavingData(false);
        }
    };
    
    const handleSaveShifts = async (date: Date, newShifts: Shift[]) => {
        if (!user) return;
        setIsSavingData(true);
        setSavingMessage('Saving schedule...');
        
        const isoDate = toISODateString(date);
        const updatedShifts = { ...shifts };

        if (newShifts.length === 0) {
            delete updatedShifts[isoDate];
        } else {
            updatedShifts[isoDate] = newShifts;
        }

        setShifts(updatedShifts);

        try {
            await api.saveUserData(user.uid, { shifts: updatedShifts });
        } catch (error) {
            console.error("Failed to save shifts:", error);
            // Optionally revert state on failure
        } finally {
            setIsSavingData(false);
        }
    };
    
    const handleSaveCashedOutHours = async (year: number, ppNumber: number, hours: number) => {
        if (!user) return;

        const targetPayPeriod = payPeriods.find(p => p.year === year && p.payPeriodOfYear === ppNumber);
        if (!targetPayPeriod) return;

        setIsSavingData(true);
        setSavingMessage('Saving...');

        const updatedHours = {
            ...cashedOutHours,
            [targetPayPeriod.number]: hours,
        };
        setCashedOutHours(updatedHours);
        
        try {
            await api.saveUserData(user.uid, { cashedOutHours: updatedHours });
        } catch (error) {
            console.error("Failed to save cashed out hours:", error);
        } finally {
            setIsSavingData(false);
        }
    };

    const renderCurrentPage = () => {
        if (!profile) return <LoadingSpinner />;

        switch (currentPage) {
            case 'dashboard':
                return <Dashboard profile={profile} shifts={shifts} cashedOutHours={cashedOutHours} onSaveCashedOutHours={handleSaveCashedOutHours} payPeriods={payPeriods} allStatHolidays={allStatHolidays} />;
            case 'schedule':
                return <WorkSchedule profile={profile} shifts={shifts} onSaveShifts={handleSaveShifts} payPeriods={payPeriods} allStatHolidays={allStatHolidays} isSaving={isSavingData}/>;
            case 'ledger':
                return <Ledger profile={profile} shifts={shifts} cashedOutHours={cashedOutHours} payPeriods={payPeriods} allStatHolidays={allStatHolidays} />;
            case 'profile':
                return <Profile profile={profile} onSave={handleSaveProfile} isSaving={isSavingData} />;
            default:
                return <h2>Page not found</h2>;
        }
    };

    if (loading) return <LoadingSpinner />;
    if (!isSupabaseConfigured) return <ConfigurationScreen />;
    if (dbError === 'missing_table') return <DatabaseSetupScreen sqlScript={getDatabaseSetupSql()} />;
    if (!session || !user) return <AuthScreen />;
    
    const sidebarAndBackdrop = (
        <>
            <Sidebar 
                currentPage={currentPage} 
                setPage={(p) => { setPage(p); setSidebarOpen(false); }} 
                onLogout={handleLogout} 
                isOpen={isSidebarOpen}
                onClose={() => setSidebarOpen(false)}
                theme={theme}
                toggleTheme={toggleTheme}
            />
            {isSidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}></div>}
        </>
    );

    return (
        <div className="app-container">
            {isSavingData && <SavingSpinner message={savingMessage}/>}
            {sidebarAndBackdrop}
            <main className="content">
                <MobileHeader currentPage={currentPage} onMenuClick={() => setSidebarOpen(true)} />
                {renderCurrentPage()}
            </main>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
