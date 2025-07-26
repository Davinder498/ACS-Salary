

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { createClient } from '@supabase/supabase-js';

import './index.css';


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
            return data as UserData;
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
const calculateSalaryForPayPeriod = (payPeriod: PayPeriod, allShifts: ShiftsData, profile: ProfileData, allStatHolidays: Record<string, string>): SalaryCalculationResult => {
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
                                            <div key={idx} className={`shift-badge ${shift.type}`}>{shift.type}</div>
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

    const handleShiftChange = (index: number, field: keyof Shift, value: any) => {
        if (field === 'type' && value === 'O') {
            const singleOffShift: Shift[] = [{ type: 'O', category: 'Regular', hasEscort: false, isBanked: false, isBookedOff: false }];
            setCurrentShifts(singleOffShift);
            return;
        }

        const newShifts = [...currentShifts];
        const currentShift = { ...newShifts[index], [field]: value };

        if (field === 'category' && value === 'Regular') {
            currentShift.isBanked = false;
        }
        
        newShifts[index] = currentShift;
        setCurrentShifts(newShifts);
    };

    const addShift = () => {
        if (currentShifts.filter(s => s.type !== 'O').length < 2) {
            const newShifts = currentShifts.filter(s => s.type !== 'O');
            setCurrentShifts([...newShifts, { type: 'D', category: 'First Overtime', hasEscort: false, isBanked: false, isBookedOff: false }]);
        }
    };
    
    const removeShift = (index: number) => {
        const remainingShifts = currentShifts.filter((_, i) => i !== index);
        if (remainingShifts.length === 0) {
            setCurrentShifts([{ type: 'O', category: 'Regular', hasEscort: false, isBanked: false, isBookedOff: false }]);
        } else {
            setCurrentShifts(remainingShifts);
        }
    };

    return (
        <div className="shift-editor-wrapper">
            {currentShifts.map((shift, index) => (
                <div key={index} className="shift-editor-item">
                    <div className="shift-editor-header">
                        <h4>{`Shift ${index + 1}`}</h4>
                        {shift.type !== 'O' && <button onClick={() => removeShift(index)} className="remove-shift-btn">Remove</button>}
                    </div>
                    <div className="form-group">
                        <label>Shift Type</label>
                        <select value={shift.type} onChange={e => handleShiftChange(index, 'type', e.target.value)}>
                            <option value="D">Day</option>
                            <option value="A">Afternoon</option>
                            <option value="N">Night</option>
                            <option value="O">Off / No Shift</option>
                        </select>
                    </div>
                     {shift.type !== 'O' && <>
                        <div className="form-group">
                             <label>Shift Category</label>
                             <select value={shift.category} onChange={e => handleShiftChange(index, 'category', e.target.value)}>
                                 <option value="Regular">Regular</option>
                                 <option value="First Overtime">First Overtime</option>
                                 <option value="Second Overtime">Second Overtime</option>
                             </select>
                         </div>
                         {shift.category !== 'Regular' &&
                            <div className="checkbox-group">
                                <input type="checkbox" id={`isBanked-${index}`} checked={!!shift.isBanked} onChange={e => handleShiftChange(index, 'isBanked', e.target.checked)} />
                                <label htmlFor={`isBanked-${index}`}>Bank this overtime shift</label>
                            </div>
                         }
                        {shift.category === 'Regular' &&
                            <div>
                                <div className="checkbox-group">
                                    <input type="checkbox" id={`isBookedOff-${index}`} checked={!!shift.isBookedOff} onChange={e => handleShiftChange(index, 'isBookedOff', e.target.checked)} />
                                    <label htmlFor={`isBookedOff-${index}`}>I booked this day off</label>
                                </div>
                                <p className="checkbox-note">Removes shift & weekend premiums.</p>
                            </div>
                        }
                        <div className="checkbox-group">
                            <input type="checkbox" id={`hasEscort-${index}`} checked={!!shift.hasEscort} onChange={e => handleShiftChange(index, 'hasEscort', e.target.checked)} />
                            <label htmlFor={`hasEscort-${index}`}>External Escort (Straight Time Meal)</label>
                        </div>
                     </>}
                </div>
            ))}

            <div className="editor-footer">
                <div>
                    {currentShifts.filter(s => s.type !== 'O').length < 2 && <button onClick={addShift} className="secondary-btn">Add Shift</button>}
                </div>
                <div>
                    <button onClick={onClose} className="cancel-btn" disabled={isSaving}>Cancel</button>
                    <button onClick={() => onSave(currentShifts)} className="save-btn" disabled={isSaving}>
                        {isSaving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface PrintablePaystubProps {
    profile: ProfileData;
    ledgerEntry: LedgerEntry | null;
    currentPayPeriod: PayPeriod;
    previousPayPeriod: PayPeriod | null;
    username: string;
}
const PrintablePaystub = ({ profile, ledgerEntry, currentPayPeriod, previousPayPeriod, username }: PrintablePaystubProps) => {
    const formatCurrency = (val: number) => (val || 0).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    
    if (!ledgerEntry) return null;

    const { data: currentPeriod, grossPay } = ledgerEntry;
    const prevDeferred = previousPayPeriod ? ledgerEntry.deferredPayFromPrevious : 0;
    const cashedOutPay = ledgerEntry.cashedOut * profile.baseRate;

    interface PaylineProps { label: string; hours?: number; pay: number; rate: number | string; }
    const Payline = ({ label, hours, pay, rate }: PaylineProps) => (
        <tr>
            <td>
                {label}
                {hours && <span className="detail-line">{hours.toFixed(2)} hrs @ {typeof rate === 'string' ? rate : formatCurrency(rate)}/hr</span>}
            </td>
            <td>{formatCurrency(pay)}</td>
        </tr>
    );

    return (
        <div className="printable-area" id="printable-paystub-content">
            <div className="stub-header">
                <div><h1>Pay Statement</h1><p>ACS Salary Calculator</p></div>
                <div>
                    <p><strong>Pay Period:</strong> {currentPayPeriod.payPeriodOfYear}-{currentPayPeriod.year}</p>
                    <p><strong>Period Dates:</strong> {currentPayPeriod.start.toLocaleDateString()} to {currentPayPeriod.end.toLocaleDateString()}</p>
                    <p><strong>Pay Date:</strong> {currentPayPeriod.end.toLocaleDateString()} (Projected)</p>
                </div>
            </div>

            <div className="stub-employee-info">
                <div><p><strong>Employee:</strong> {username}</p></div>
                <div><p><strong>Hourly Rate:</strong> {formatCurrency(profile.baseRate)}</p></div>
            </div>

            <div className="stub-main-content">
                <div className="stub-column">
                    <div className="stub-section-title">Earnings</div>
                    <table className="stub-table">
                        <tbody>
                            <Payline label="Base Salary" hours={currentPeriod.regularPay.hours} pay={currentPeriod.regularPay.pay} rate={profile.baseRate} />
                            {prevDeferred > 0 && <tr><td>Deferred Pay (from PP {previousPayPeriod?.payPeriodOfYear})</td><td>{formatCurrency(prevDeferred)}</td></tr>}
                            {cashedOutPay > 0 && <Payline label="Cashed Out Banked OT" hours={ledgerEntry.cashedOut} pay={cashedOutPay} rate={profile.baseRate} />}
                            <tr className="total-row"><td>Gross Pay</td><td>{formatCurrency(grossPay)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
            
            <div className="stub-section-title">Banked Overtime Summary</div>
             <table className="stub-table">
                <thead><tr><th>Description</th><th>Hours</th></tr></thead>
                <tbody>
                    <tr><td>Previous Balance</td><td>{ledgerEntry.startBalance.toFixed(2)}</td></tr>
                    <tr><td>Banked This Period (equiv. hrs)</td><td>+ {ledgerEntry.data.equivalentBankedOtHours.toFixed(2)}</td></tr>
                    <tr><td>Cashed Out This Period</td><td>- {ledgerEntry.cashedOut.toFixed(2)}</td></tr>
                    <tr className="total-row"><td>Ending Balance</td><td>{ledgerEntry.endBalance.toFixed(2)}</td></tr>
                </tbody>
            </table>
            
             <div className="stub-section-title">Memo: Deferred Earnings for Next Paycheck</div>
             <p style={{fontSize: '12px', color: '#555'}}>The following earnings from the current pay period will be paid on the next paycheck.</p>
             <table className="stub-table">
                 <tbody>
                    {Object.entries(currentPeriod.deferred).map(([key, value]) => {
                         if(value.pay > 0) return <tr key={key}><td>{key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</td><td>{formatCurrency(value.pay)}</td></tr>
                    })}
                 </tbody>
             </table>
        </div>
    );
};

interface AnnualProjectionChartProps {
    data: AnnualProjectionData;
    profile: ProfileData;
}
const AnnualProjectionChart = ({ data, profile }: AnnualProjectionChartProps) => {
    const formatCurrency = (val: number, compact = false) => {
        if (compact) {
            if (val >= 1000) return `${(val/1000).toFixed(0)}k`;
        }
        return (val || 0).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    };

    const { breakdown } = data;
    const aggregatedData = useMemo(() => [
        { label: "Base Salary", value: breakdown.baseSalary.pay, color: 'var(--day-shift-color)' },
        { label: "Overtime", value: breakdown.ot1_5x.pay + breakdown.ot2x.pay, color: 'var(--afternoon-shift-color)' },
        { label: "Premiums", value: breakdown.afternoon.pay + breakdown.night.pay + breakdown.weekend.pay, color: 'var(--night-shift-color)' },
        { label: "Bonuses & Other", value: breakdown.statHolidayBonus.pay + breakdown.stm.pay, color: 'var(--stat-holiday-color)' },
    ].filter(d => d.value > 1), [breakdown]);

    const { width, height } = { width: 800, height: 400 };
    const margin = { top: 40, right: 20, bottom: 60, left: 60 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const maxValue = Math.max(...aggregatedData.map(d => d.value));
    const tickCount = 5;
    const niceMaxValue = Math.ceil(maxValue / (tickCount * 10000)) * (tickCount * 10000);
    const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => (niceMaxValue / tickCount) * i);

    const barWidth = innerWidth / aggregatedData.length * 0.6;
    const barGap = innerWidth / aggregatedData.length * 0.4;
    
    return (
        <div className="annual-chart-container">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="chart-title">
                <title id="chart-title">Bar chart showing the breakdown of annual projected earnings.</title>
                <g transform={`translate(${margin.left}, ${margin.top})`}>
                    <g className="y-axis">
                        <line x1="0" y1="0" x2="0" y2={innerHeight} className="axis-line" />
                        {yTicks.map(tickValue => (
                            <g key={tickValue} className="tick" transform={`translate(0, ${innerHeight - (tickValue / niceMaxValue) * innerHeight})`}>
                                <line x1="-5" y1="0" x2="0" y2="0" />
                                <text x="-10" y="0" dy="0.32em" textAnchor="end">{formatCurrency(tickValue, true)}</text>
                            </g>
                        ))}
                    </g>

                    <g className="x-axis" transform={`translate(0, ${innerHeight})`}>
                        <line x1="0" y1="0" x2={innerWidth} y2="0" className="axis-line" />
                    </g>
                    
                    {aggregatedData.map((d, i) => {
                        const x = i * (barWidth + barGap) + barGap / 2;
                        const y = innerHeight - (d.value / niceMaxValue) * innerHeight;
                        const barHeight = (d.value / niceMaxValue) * innerHeight;
                        return (
                            <g key={d.label}>
                                <rect
                                    x={x}
                                    y={y}
                                    width={barWidth}
                                    height={barHeight}
                                    fill={d.color}
                                    className="bar"
                                >
                                  <title>{`${d.label}: ${formatCurrency(d.value)}`}</title>
                                </rect>
                                <text x={x + barWidth / 2} y={innerHeight + 20} className="bar-label">{d.label}</text>
                                <text x={x + barWidth / 2} y={y - 8} className="bar-value-label">{formatCurrency(d.value, true)}</text>
                            </g>
                        );
                    })}
                </g>
            </svg>
        </div>
    );
};

interface LedgerPageProps {
    ledger: LedgerEntry[];
    currentGlobalPPNumber: number | undefined;
}

const LedgerPage = React.memo(({ ledger, currentGlobalPPNumber }: LedgerPageProps) => {
    useEffect(() => {
        if (ledger.length > 0 && currentGlobalPPNumber) {
            const activeRow = document.getElementById(`ledger-row-${currentGlobalPPNumber}`);
            if (activeRow) {
                activeRow.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }
    }, [currentGlobalPPNumber, ledger]);
    
    if (ledger.length === 0) {
        return (
            <div>
                <div className="page-header"><h2>Banked OT Ledger</h2></div>
                <div className="card" style={{textAlign: 'center', padding: '2rem'}}>
                    <p>There is no ledger data to display.</p>
                    <p style={{marginTop: '0.5rem', color: 'var(--text-secondary)'}}>Complete your profile to get started.</p>
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="page-header"><h2>Banked OT Ledger</h2></div>
            <div className="card ledger-card">
                <div className="ledger-table">
                    <div className="ledger-row ledger-header">
                        <span>Pay Period</span>
                        <span>Start Balance</span>
                        <span>Banked</span>
                        <span>Cashed Out</span>
                        <span>End Balance</span>
                    </div>
                    <div className="ledger-body full-page">
                        {ledger.map((entry: LedgerEntry) => {
                            const isActive = !!currentGlobalPPNumber && entry.globalPPNumber === currentGlobalPPNumber;
                            return (
                                <div 
                                    className={`ledger-row ${isActive ? 'active' : ''}`} 
                                    key={entry.globalPPNumber}
                                    id={`ledger-row-${entry.globalPPNumber}`}
                                >
                                    <span data-label="Pay Period">PP {entry.ppNumber} ({entry.year})</span>
                                    <span data-label="Start Balance">{entry.startBalance.toFixed(2)}</span>
                                    <span className="added" data-label="Banked">+ {entry.data.equivalentBankedOtHours.toFixed(2)}</span>
                                    <span className="removed" data-label="Cashed Out">- {entry.cashedOut.toFixed(2)}</span>
                                    <span data-label="End Balance">{entry.endBalance.toFixed(2)} hrs</span>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
});


interface DashboardProps {
    username: string;
    profile: ProfileData;
    cashedOutHours: CashedOutHoursData;
    onCashedOutHoursChange: (data: CashedOutHoursData) => void;
    payPeriods: PayPeriod[];
    ledger: LedgerEntry[];
    calculationEndIndex: number;
}
const Dashboard = React.memo(({ username, profile, cashedOutHours, onCashedOutHoursChange, payPeriods, ledger, calculationEndIndex }: DashboardProps) => {
    const [currentPPIndex, setCurrentPPIndex] = useState(() => getCurrentPayPeriodIndex(payPeriods));
    const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
    const [activeTab, setActiveTab] = useState('summary');
    const [annualViewMode, setAnnualViewMode] = useState('text');
    const [localCashedOutValue, setLocalCashedOutValue] = useState<string>('');

    const deferredPayMeta = useMemo(() => ({
        ot1_5x: { label: 'Overtime (1.5x)', rate: profile.baseRate * 1.5 },
        ot2x: { label: 'Overtime (2.0x)', rate: profile.baseRate * 2.0 },
        statHolidayBonus: { label: 'Stat Holiday Bonus', rate: profile.baseRate * 0.5 },
        afternoon: { label: 'Afternoon Differential', rate: '$2.75' },
        night: { label: 'Night Differential', rate: '$5.00' },
        weekend: { label: 'Weekend Premium', rate: '$3.25' },
        stm: { label: 'Straight Time Meal', rate: profile.baseRate },
    }), [profile.baseRate]);

    useEffect(() => {
        if (!payPeriods || payPeriods.length === 0) return;
        const value = cashedOutHours?.[String(payPeriods[currentPPIndex].number)];
        setLocalCashedOutValue(value ? String(value) : '');
    }, [currentPPIndex, cashedOutHours, payPeriods]);
    
    const handleCashOutInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setLocalCashedOutValue(e.target.value);
    };

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            if (!payPeriods[currentPPIndex]) return;
            const currentGlobalPP = payPeriods[currentPPIndex].number;
            const hours = parseFloat(localCashedOutValue) || 0;
            const currentHours = cashedOutHours?.[String(currentGlobalPP)] || 0;
    
            if (hours !== currentHours) {
                const newCashedOutHours = {
                    ...(cashedOutHours || {}),
                    [String(currentGlobalPP)]: hours < 0 ? 0 : hours,
                };
                if (localCashedOutValue === '' || hours === 0) {
                     delete newCashedOutHours[String(currentGlobalPP)];
                }
                onCashedOutHoursChange(newCashedOutHours);
            }
        }, 500);
        return () => clearTimeout(timeoutId);
    }, [localCashedOutValue, currentPPIndex, cashedOutHours, onCashedOutHoursChange, payPeriods]);

    if (!payPeriods || !payPeriods[currentPPIndex]) {
        return <div className="card" style={{textAlign: 'center', padding: '2rem'}}>Loading pay period data...</div>;
    }

    const salaryData = useMemo(() => {
        if (ledger.length === 0) {
             if (!profile || !profile.baseRate || profile.baseRate <= 0) return { error: "Please set a valid Base Rate in your Profile." };
             if (!profile.workCycleReference) return { error: "Please set your Work Cycle to see a projected salary." };
             return { error: "Calculating salary data..." };
        }
        
        const currentLedgerEntry = ledger.find(l => l.globalPPNumber === payPeriods[currentPPIndex].number);
        const previousLedgerEntry = currentPPIndex > 0 ? ledger.find(l => l.globalPPNumber === payPeriods[currentPPIndex - 1].number) : null;

        if (!currentLedgerEntry) {
            return { error: "Pay period data is not available." };
        }
        
        return {
            error: null,
            ledgerEntry: currentLedgerEntry,
            previousLedgerEntry,
        };
    }, [currentPPIndex, ledger, profile, payPeriods]);
    
    const currentPayPeriod = payPeriods[currentPPIndex];
    const previousPayPeriod = currentPPIndex > 0 ? payPeriods[currentPPIndex - 1] : null;

    const annualProjectionData = useMemo<AnnualProjectionData | null>(() => {
        if (activeTab !== 'annual' || ledger.length === 0) return null;

        const projectionYear = currentPayPeriod.year;
        
        const totals: DeferredPay & { baseSalary: PayDetails } = {
            baseSalary: { pay: 0, hours: 0 },
            ot1_5x: { pay: 0, hours: 0 }, ot2x: { pay: 0, hours: 0 },
            afternoon: { pay: 0, hours: 0 }, night: { pay: 0, hours: 0 },
            weekend: { pay: 0, hours: 0 }, stm: { pay: 0, hours: 0 },
            statHolidayBonus: { pay: 0, hours: 0 }
        };

        const payPeriodsInYear = ledger.filter(entry => entry.year === projectionYear);

        for (const entry of payPeriodsInYear) {
            const { data } = entry;
            totals.baseSalary.pay += data.regularPay.pay;
            totals.baseSalary.hours += data.regularPay.hours;
            const deferredKeys: (keyof DeferredPay)[] = ['ot1_5x', 'ot2x', 'afternoon', 'night', 'weekend', 'stm', 'statHolidayBonus'];
            for (const key of deferredKeys) {
                totals[key].pay += data.deferred[key].pay;
                totals[key].hours += data.deferred[key].hours;
            }
        }
        
        const totalGrossPay = Object.values(totals).reduce((sum, category) => sum + category.pay, 0);

        return { year: projectionYear, totalGrossPay, breakdown: totals };
    }, [activeTab, currentPayPeriod.year, ledger]);
    
    const displayablePayPeriods = useMemo(() => payPeriods.slice(0, calculationEndIndex + 1), [payPeriods, calculationEndIndex]);
    const availableYears = useMemo(() => [...new Set(displayablePayPeriods.map(p => p.year))], [displayablePayPeriods]);
    const payPeriodsForYear = useMemo(() => displayablePayPeriods.filter(p => p.year === currentPayPeriod.year), [displayablePayPeriods, currentPayPeriod.year]);

    const handleYearChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const year = parseInt(e.target.value, 10);
        const firstPpOfSelectedYear = displayablePayPeriods.find(p => p.year === year);
        if (firstPpOfSelectedYear) {
            const newIndex = payPeriods.findIndex(p => p.number === firstPpOfSelectedYear.number);
            if (newIndex !== -1) setCurrentPPIndex(newIndex);
        }
    };

    const handlePayPeriodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const ppInYear = parseInt(e.target.value, 10);
        const targetPpIndex = payPeriods.findIndex(p => p.year === currentPayPeriod.year && p.payPeriodOfYear === ppInYear);
        if (targetPpIndex !== -1) {
            setCurrentPPIndex(targetPpIndex);
        }
    };
    
    const formatCurrency = (val: number) => (val || 0).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    
    const handleDownloadPdf = async () => {
        if (isGeneratingPdf || salaryData.error) return;
        setIsGeneratingPdf(true);
    
        setTimeout(async () => {
            const printableElement = document.getElementById('printable-paystub-content');
            if (!printableElement) {
                setIsGeneratingPdf(false);
                return;
            }
    
            try {
                const canvas = await html2canvas(printableElement, { scale: 2 });
                const imgData = canvas.toDataURL('image/png');
                const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = pdf.internal.pageSize.getHeight();
                const canvasAspectRatio = canvas.width / canvas.height;
                
                let imgWidth = pdfWidth - 80;
                let imgHeight = imgWidth / canvasAspectRatio;
                
                if (imgHeight > pdfHeight - 80) {
                    imgHeight = pdfHeight - 80;
                    imgWidth = imgHeight * canvasAspectRatio;
                }
                
                const x = (pdfWidth - imgWidth) / 2;
                const y = 40;
    
                pdf.addImage(imgData, 'PNG', x, y, imgWidth, imgHeight);
                
                const fileName = `Paystub-PP${currentPayPeriod.payPeriodOfYear}-${currentPayPeriod.year}.pdf`;
                pdf.save(fileName);
    
            } catch (error) {
                console.error("PDF generation failed:", error);
                alert("Sorry, there was an an error generating the PDF.");
            } finally {
                setIsGeneratingPdf(false);
            }
        }, 100); 
    };
    
    const PayDetailLine = ({ label, hours, rate, pay }: { label: string; hours?: number; rate?: number | string; pay: number; }) => (
        <div className="card-item">
            <span>
                {label}
                {hours > 0 && typeof rate !== 'undefined' && <span className="item-details">{hours.toFixed(2)} hrs @ {typeof rate === 'string' ? rate : formatCurrency(rate)}/hr</span>}
            </span>
            <span>{formatCurrency(pay)}</span>
        </div>
    );
    
    const { ledgerEntry, previousLedgerEntry } = salaryData;

    return (
        <div>
            {isGeneratingPdf && ledgerEntry && (
                <div className="printable-area-container">
                     <PrintablePaystub 
                        profile={profile}
                        ledgerEntry={ledgerEntry}
                        currentPayPeriod={currentPayPeriod}
                        previousPayPeriod={previousPayPeriod}
                        username={username}
                    />
                </div>
            )}
            <div className="page-header"><h2>Dashboard</h2></div>
            
            <div className="dashboard-controls">
                <button onClick={() => setCurrentPPIndex(i => Math.max(0, i - 1))} disabled={currentPPIndex === 0}>Previous PP</button>
                <div className="pay-period-selectors">
                    <select value={currentPayPeriod.year} onChange={handleYearChange} aria-label="Select Year">
                         {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                     <select value={currentPayPeriod.payPeriodOfYear} onChange={handlePayPeriodChange} aria-label="Select Pay Period">
                        {payPeriodsForYear.map(pp => (
                            <option key={pp.payPeriodOfYear} value={pp.payPeriodOfYear}>
                                PP {pp.payPeriodOfYear}: {pp.start.toLocaleDateString()} - {pp.end.toLocaleDateString()}
                            </option>
                        ))}
                    </select>
                </div>
                <button onClick={() => setCurrentPPIndex(i => Math.min(calculationEndIndex, i + 1))} disabled={currentPPIndex >= calculationEndIndex}>Next PP</button>
            </div>
            
            {salaryData.error ? <div className="card" style={{textAlign: 'center', padding: '2rem'}}>{salaryData.error}</div> :
            <>
                <div className="dashboard-tabs">
                    <button className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>Pay Period Summary</button>
                    <button className={activeTab === 'annual' ? 'active' : ''} onClick={() => setActiveTab('annual')}>Annual Projection</button>
                </div>
                
                {activeTab === 'summary' && ledgerEntry &&
                    <div className="dashboard-grid">
                        <div className="card card-full-width">
                            <div className="dashboard-card-header">
                                <h3>Projected Paycheck for PP {currentPayPeriod.payPeriodOfYear} ({currentPayPeriod.year})</h3>
                                <button onClick={handleDownloadPdf} disabled={isGeneratingPdf || !!salaryData.error} className="pdf-download-btn">
                                <DownloadIcon /> {isGeneratingPdf ? 'Generating...' : 'Download PDF'}
                                </button>
                            </div>
                            
                            <div className="paycheck-hero">
                                <span className="paycheck-hero-label">Projected Gross Pay</span>
                                <span className="paycheck-hero-amount">{formatCurrency(ledgerEntry.grossPay)}</span>
                            </div>
                            
                            <div className="paycheck-details">
                                <p className="card-subtitle">Earnings</p>
                                <PayDetailLine label="Base Salary" hours={ledgerEntry.data.regularPay.hours} rate={profile.baseRate} pay={ledgerEntry.data.regularPay.pay} />
                                
                                {previousLedgerEntry && Object.entries(previousLedgerEntry.data.deferred).map(([key, value]) => {
                                    if (value.pay <= 0) return null;
                                    const meta = deferredPayMeta[key as keyof DeferredPay];
                                    if (!meta) return null;
                                    return (
                                        <PayDetailLine
                                            key={`deferred-${key}`}
                                            label={meta.label}
                                            hours={value.hours}
                                            rate={meta.rate}
                                            pay={value.pay}
                                        />
                                    );
                                })}

                                <div className="card-input-item" style={{borderTop: '1px dashed var(--border-color)', paddingTop: '1.5rem', marginTop: '1rem'}}>
                                    <label htmlFor="cashed-out-ot">Cashed Out Banked OT (hours)</label>
                                    <input type="number" id="cashed-out-ot" value={localCashedOutValue} onChange={handleCashOutInputChange} placeholder="0" step="0.01" min="0"/>
                                </div>
                                <p className="card-input-note">Cashed out at 1x base rate</p>
                                {ledgerEntry.cashedOut > 0 && <PayDetailLine label="Cashed Out OT Pay" hours={ledgerEntry.cashedOut} rate={profile.baseRate} pay={ledgerEntry.cashedOut * profile.baseRate} />}
                                
                                <div className="card-item total-line"><span>Gross Pay</span><span>{formatCurrency(ledgerEntry.grossPay)}</span></div>

                            </div>
                        </div>

                        <div className="card">
                            <div className="dashboard-card-header"><h3>Earnings to be Deferred (from PP {currentPayPeriod.payPeriodOfYear})</h3></div>
                            <p style={{color: 'var(--text-secondary)', fontSize: '0.9em', marginBottom: '1rem'}}>Note: These amounts will be paid in PP {currentPayPeriod.number + 1 <= payPeriods.length ? (payPeriods[currentPPIndex+1].payPeriodOfYear) : 'Next'}.</p>
                            
                            {Object.entries(ledgerEntry.data.deferred).map(([key, value]) => {
                                if (value.pay <= 0) return null;
                                const meta = deferredPayMeta[key as keyof DeferredPay];
                                if (!meta) return null;
                                return (
                                    <PayDetailLine 
                                        key={`current-deferred-${key}`}
                                        label={meta.label} 
                                        hours={value.hours} 
                                        rate={meta.rate}
                                        pay={value.pay} />
                                );
                            })}
                        </div>
                    </div>
                }

                {activeTab === 'annual' && 
                    <div className="dashboard-grid">
                        <div className="card card-full-width">
                            {annualProjectionData ? (
                                <>
                                    <div className="dashboard-card-header">
                                        <h3>Annual Projection for {annualProjectionData.year}</h3>
                                        <div className="view-switcher">
                                            <button className={annualViewMode === 'text' ? 'active' : ''} onClick={() => setAnnualViewMode('text')} aria-label="Switch to text view">
                                                <ListIcon /> Text
                                            </button>
                                            <button className={annualViewMode === 'visual' ? 'active' : ''} onClick={() => setAnnualViewMode('visual')} aria-label="Switch to visual view">
                                                <BarChartIcon /> Visual
                                            </button>
                                        </div>
                                    </div>
                                    <div className="paycheck-hero">
                                        <span className="paycheck-hero-label">Projected Annual Gross Pay</span>
                                        <span className="paycheck-hero-amount">{formatCurrency(annualProjectionData.totalGrossPay)}</span>
                                    </div>

                                    {annualViewMode === 'text' ? (
                                        <div className="paycheck-details">
                                            <p className="card-subtitle">EARNINGS BREAKDOWN</p>
                                            <PayDetailLine label="Base Salary" hours={annualProjectionData.breakdown.baseSalary.hours} rate={profile.baseRate} pay={annualProjectionData.breakdown.baseSalary.pay} />
                                            
                                            {(Object.keys(deferredPayMeta) as (keyof DeferredPay)[]).map(key => {
                                                const breakdown = annualProjectionData.breakdown as any;
                                                const value = breakdown[key];
                                                if (!value || value.pay <= 0) return null;
                                                const meta = deferredPayMeta[key];
                                                return (
                                                    <PayDetailLine 
                                                        key={`annual-${key}`}
                                                        label={meta.label}
                                                        hours={value.hours}
                                                        rate={meta.rate}
                                                        pay={value.pay}
                                                    />
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <AnnualProjectionChart data={annualProjectionData} profile={profile} />
                                    )}

                                    <p style={{textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '1.5rem'}}>
                                        Note: This projection is based on the current schedule for the entire year and assumes all overtime is paid out, not banked.
                                    </p>
                                </>
                            ) : (
                                <div style={{textAlign: 'center', padding: '2rem'}}>
                                    <p>Complete your profile and schedule to see an annual projection.</p>
                                </div>
                            )}
                        </div>
                    </div>
                }
            </>
            }
        </div>
    );
});

// --- Helper to detect auth errors ---
const isAuthError = (error: any): boolean => {
    // Supabase throws errors with specific structures. A 401 status is a clear sign.
    // Also checking for messages is a good fallback for JWT-related issues.
    return error && (error.status === 401 || /jwt/i.test(error.message));
};

const App = () => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState('dashboard');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [theme, setTheme] = useState(() => localStorage.getItem('acs-salary-theme') || 'dark');
    const [databaseSetupError, setDatabaseSetupError] = useState<string | null>(null);
    const [savingMessage, setSavingMessage] = useState<string | null>(null);

    const toggleTheme = useCallback(() => {
        setTheme(prevTheme => (prevTheme === 'dark' ? 'light' : 'dark'));
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('acs-salary-theme', theme);
    }, [theme]);

    if (!isSupabaseConfigured) {
        return <ConfigurationScreen />;
    }

    const handleLogout = async () => {
        setIsSidebarOpen(false); // Good UX for mobile
        await api.logout();
        setUser(null);
    };
    
    useEffect(() => {
        setDatabaseSetupError(null);
        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
            const sessionUser = session?.user;
            if (sessionUser) {
                try {
                    const userData = await api.getUserData(sessionUser.id);
                    setUser({
                        uid: sessionUser.id,
                        ...userData
                    });
                    setDatabaseSetupError(null); // Clear error on success
                } catch (error: any) {
                    const errorMessage = typeof error?.message === 'string' ? error.message : '';
                    if (error?.code === '42P01' || errorMessage.includes('relation "public.profiles" does not exist')) {
                        console.error("Database setup needed:", errorMessage);
                        setDatabaseSetupError(getDatabaseSetupSql());
                    } else if (isAuthError(error)) {
                        console.error("Auth error during initial data fetch, logging out.", error);
                        handleLogout();
                    }
                    else {
                        console.error("Logging out due to data fetch failure:", error);
                    }
                    setUser(null);
                } finally {
                    setLoading(false);
                }
            } else {
                setUser(null);
                setLoading(false);
                setDatabaseSetupError(null);
            }
        });
    
        return () => {
            subscription?.unsubscribe();
        };
    }, []);

    // FIX: Proactively refresh session on mobile when app is brought to foreground
    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (document.visibilityState === 'visible' && isSupabaseConfigured) {
                // This call refreshes the session from localStorage and ensures the
                // auth token is up-to-date, which is crucial for mobile devices
                // returning from the background.
                await supabase.auth.getSession();
            }
        };
    
        document.addEventListener('visibilitychange', handleVisibilityChange);
    
        // Clean up the event listener when the component unmounts
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    const allStatHolidays = useMemo(() => {
        let holidays: Record<string, string> = {};
        const currentYear = new Date().getFullYear();
        for (let year = currentYear - 10; year <= currentYear + 20; year++) {
            holidays = { ...holidays, ...getStatHolidaysForYear(year) };
        }
        return holidays;
    }, []);

    const payPeriods = useMemo(() => {
        let periods: PayPeriod[] = [];
        let startDate = new Date(BASE_PAY_PERIOD_START_DATE);
        let payPeriodOfYear = 1;
        let year = 2025;
        for (let i = 1; i <= 26 * 30; i++) {
            const endDate = addDays(startDate, PAY_PERIOD_LENGTH_DAYS - 1);
            periods.push({ number: i, payPeriodOfYear, year, start: startDate, end: endDate });
            startDate = addDays(endDate, 1);
            payPeriodOfYear++;
            if (payPeriodOfYear > 26) {
                payPeriodOfYear = 1;
                year++;
            }
        }
        return periods;
    }, []);
    
    // --- Performance Optimization: Split calculations into two stages ---
    
    // Stage 1: Perform the heavy, base calculations for salary.
    // This only re-runs when the user's profile or shifts change.
    const baseCalculations = useMemo(() => {
        if (!user || !user.profile.baseRate || user.profile.baseRate <= 0 || !user.profile.workCycleReference) {
            return { calculationResults: [], calculationEndIndex: 0 };
        }

        const today = new Date();
        const currentPPIndexForRange = payPeriods.findIndex(p => today >= p.start && today <= p.end);
        const effectiveCurrentPPIndex = currentPPIndexForRange > -1 ? currentPPIndexForRange : 0;
        const calculationEndIndex = Math.min(effectiveCurrentPPIndex + 52, payPeriods.length - 1);
        
        const calculationResults: { pp: PayPeriod, data: SalaryCalculationResult }[] = [];
        for (let i = 0; i <= calculationEndIndex; i++) {
            const pp = payPeriods[i];
            const ppData = calculateSalaryForPayPeriod(pp, user.shifts, user.profile, allStatHolidays);
            calculationResults.push({ pp, data: ppData });
        }

        return { calculationResults, calculationEndIndex };
    }, [user?.profile, user?.shifts, payPeriods, allStatHolidays]);

    // Stage 2: Build the full ledger using the cached base calculations.
    // This re-runs when the base calculations change OR when cashed out hours change.
    // It's much faster because it doesn't have to recalculate the salary for every period.
    const financialData = useMemo(() => {
        const { calculationResults, calculationEndIndex } = baseCalculations;
        if (!user || calculationResults.length === 0) {
             return { ledger: [] as LedgerEntry[], calculationEndIndex };
        }

        const ledger: LedgerEntry[] = [];
        let runningBalance = 0;
        let ytd = { gross: 0 };
        let lastYear = -1;

        for (let i = 0; i < calculationResults.length; i++) {
            const { pp, data: ppData } = calculationResults[i];

            if (pp.year !== lastYear) {
                ytd = { gross: 0 };
                lastYear = pp.year;
            }

            const cashedOutHours = user.cashedOutHours?.[String(pp.number)] || 0;
            const cashedOutPay = cashedOutHours * user.profile.baseRate;
            
            const prevDeferred = i > 0 ? ledger[i-1].data.deferred : null;
            const deferredPayFromPrevious = prevDeferred ? Object.values(prevDeferred).reduce((sum, cat) => sum + cat.pay, 0) : 0;
            
            const grossPay = ppData.regularPay.pay + deferredPayFromPrevious + cashedOutPay;
            
            ytd.gross += grossPay;

            const startBalance = runningBalance;
            const endBalance = startBalance + ppData.equivalentBankedOtHours - cashedOutHours;
    
            ledger.push({
                ppNumber: pp.payPeriodOfYear,
                year: pp.year,
                globalPPNumber: pp.number,
                data: ppData,
                cashedOut: cashedOutHours,
                startBalance,
                endBalance,
                grossPay,
                deferredPayFromPrevious,
                ytdGross: ytd.gross
            });
            runningBalance = endBalance;
        }
        
        return { ledger, calculationEndIndex };
    }, [baseCalculations, user?.cashedOutHours, user?.profile?.baseRate]);


    const handleSaveProfile = async (newProfile: ProfileData) => {
        if (!user || savingMessage) return;

        setSavingMessage("Saving profile...");

        try {
            await api.saveUserData(user.uid, { profile: newProfile });
            // The heavy calculation happens here, while the spinner is visible.
            setUser(prev => prev ? ({ ...prev, profile: newProfile }) : null);
        } catch (error: any) {
            console.error("Failed to save profile:", error);
            if (isAuthError(error)) {
                alert("Your session has expired. Please log in again.");
                handleLogout();
            } else {
                alert("Error: Could not save your profile. Please check your connection and try again.");
                // No rollback needed as state was not updated optimistically.
            }
        } finally {
            setSavingMessage(null);
        }
    };

    const handleSaveShiftsForDate = async (selectedDate: Date, newShiftsFromEditor: Shift[]) => {
        if (!user || !user.profile || savingMessage) return;
    
        const isoSelected = toISODateString(selectedDate);
        const updatedShifts = JSON.parse(JSON.stringify(user.shifts || {}));
    
        // Normalize the editor output for comparison. A single 'O' shift means "no working shifts".
        const normalizedNewShifts = (newShiftsFromEditor.length === 1 && newShiftsFromEditor[0].type === 'O') 
            ? [] 
            : newShiftsFromEditor;
    
        // Get the default shifts from the pattern for comparison.
        const defaultShiftsForSelectedDate = getEffectiveShiftsForDate(selectedDate, {}, user.profile);
    
        const newConfigIsDefault =
            JSON.stringify(normalizedNewShifts.sort((a, b) => a.type.localeCompare(b.type))) ===
            JSON.stringify(defaultShiftsForSelectedDate.sort((a, b) => a.type.localeCompare(b.type)));
    
        if (newConfigIsDefault) {
            delete updatedShifts[isoSelected];
        } else {
            updatedShifts[isoSelected] = newShiftsFromEditor;
        }
        
        setSavingMessage("Saving schedule...");

        try {
            await api.saveUserData(user.uid, { shifts: updatedShifts });
            // The heavy calculation happens here, while the spinner is visible.
            setUser(prev => (prev ? { ...prev, shifts: updatedShifts } : null));
        } catch (error: any) {
            console.error("Failed to save shifts:", error);
             if (isAuthError(error)) {
                alert("Your session has expired. Please log in again.");
                handleLogout();
            } else {
                alert("Error: Could not save your schedule changes. Please check your connection and try again.");
                // No rollback needed as state was not updated optimistically.
            }
        } finally {
            setSavingMessage(null);
        }
    };

    const handleCashedOutHoursChange = async (newCashedOutHours: CashedOutHoursData) => {
        if (!user || savingMessage) return;

        const oldCashedOutHours = user.cashedOutHours;
        setUser(prev => prev ? ({ ...prev, cashedOutHours: newCashedOutHours }) : null); // Optimistic update

        try {
            await api.saveUserData(user.uid, { cashedOutHours: newCashedOutHours });
            // No success alert for debounced auto-save to avoid being annoying.
        } catch (error: any) {
            console.error("Failed to auto-save cashed out hours:", error);
            if (isAuthError(error)) {
                alert("Your session has expired and auto-save failed. Please log in again.");
                handleLogout();
            } else {
                alert("Auto-save for cashed out hours failed. Your change was not saved. Please check your connection and try again.");
                setUser(prev => prev ? ({ ...prev, cashedOutHours: oldCashedOutHours }) : null); // Rollback
            }
        }
    };

    const handleSetPage = (newPage: string) => {
        setPage(newPage);
        setIsSidebarOpen(false);
    };

    if (loading) {
        return <LoadingSpinner />;
    }

    if (databaseSetupError) {
        return <DatabaseSetupScreen sqlScript={databaseSetupError} />;
    }

    if (!user) {
        return <AuthScreen />;
    }

    const currentPPIndex = getCurrentPayPeriodIndex(payPeriods);

    return (
        <div className="app-container">
            {savingMessage && <SavingSpinner message={savingMessage} />}
            <Sidebar 
                currentPage={page} 
                setPage={handleSetPage} 
                onLogout={handleLogout} 
                isOpen={isSidebarOpen}
                onClose={() => setIsSidebarOpen(false)}
                theme={theme}
                toggleTheme={toggleTheme}
            />
            {isSidebarOpen && <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)}></div>}
            <main className="content">
                <MobileHeader currentPage={page} onMenuClick={() => setIsSidebarOpen(true)} />
                {page === 'dashboard' && <Dashboard 
                    username={user.email || ''}
                    profile={user.profile} 
                    cashedOutHours={user.cashedOutHours} 
                    onCashedOutHoursChange={handleCashedOutHoursChange}
                    payPeriods={payPeriods}
                    ledger={financialData.ledger}
                    calculationEndIndex={financialData.calculationEndIndex}
                />}
                {page === 'schedule' && <WorkSchedule 
                    profile={user.profile} 
                    shifts={user.shifts} 
                    onSaveShifts={handleSaveShiftsForDate}
                    payPeriods={payPeriods}
                    allStatHolidays={allStatHolidays}
                    isSaving={!!savingMessage}
                />}
                {page === 'profile' && <Profile 
                    profile={user.profile} 
                    onSave={handleSaveProfile}
                    isSaving={!!savingMessage} 
                />}
                {page === 'ledger' && <LedgerPage 
                    ledger={financialData.ledger} 
                    currentGlobalPPNumber={payPeriods[currentPPIndex]?.number}
                />}
            </main>
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);