import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the app's actual payroll functions without starting its browser UI or backend.
const source = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [
    'PAY_PERIOD_LENGTH_DAYS', 'WORK_CYCLE_LENGTH_DAYS', 'toISODateString', 'addDays',
    'getWorkCycleDayForDate', 'getEffectiveShiftsForDate', 'getScheduledShiftType',
    'calculateEarningsForPeriod',
];
const statements = ast.statements.filter(statement => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(ast))));
assert.equal(statements.length, names.length, 'All payroll dependencies must be loaded');
const compiled = ts.transpileModule(statements.map(statement => statement.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const calculate = vm.runInNewContext(`${compiled}\ncalculateEarningsForPeriod;`, { Date });

const shift = (type, category = 'Regular', extra = {}) => ({
    type, category, hasEscort: false, isBanked: false, isBookedOff: false, ...extra,
});
const overtime = (type, extra = {}) => shift(type, 'First Overtime', extra);

function earnings(date, shifts, { pattern = Array(9).fill('O'), holidays = {} } = {}) {
    const start = new Date(`${date}T00:00:00`);
    const allShifts = {};
    for (let offset = 0; offset < 14; offset++) {
        const day = new Date(start);
        day.setDate(day.getDate() + offset);
        const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        allShifts[iso] = [shift('O')];
    }
    if (shifts === null) delete allShifts[date];
    else allShifts[date] = shifts;
    return calculate({ start }, allShifts, {
        baseRate: 40,
        workCycleReference: { date, day: 1, pattern },
    }, holidays);
}

function premiums(result, nightHours = 0, lateNightHours = 0, weekendHours = 0) {
    for (const [key, hours, rate] of [
        ['afternoon', nightHours, 2.75], ['night', lateNightHours, 5], ['weekend', weekendHours, 3.25],
    ]) {
        assert.equal(result.deferred[key].hours, hours, `${key} hours`);
        assert.equal(result.deferred[key].pay, hours * rate, `${key} pay`);
    }
}

test('regular night shift grants night premiums on late-night overtime', () => {
    premiums(earnings('2026-10-13', [shift('A'), overtime('N')]), 15.5);
});

test('regular late-night shift grants late-night premiums on night overtime', () => {
    premiums(earnings('2026-10-13', [shift('N'), overtime('A')]), 0, 15.5);
});

test('weekday day shift grants no night premiums on overtime', () => {
    premiums(earnings('2026-10-13', [shift('D'), overtime('N')]));
});

test('Friday night regular shift carries weekend eligibility into late-night overtime', () => {
    premiums(earnings('2026-10-16', [shift('A'), overtime('N')]), 15.5, 0, 15.5);
});

test('Friday day regular shift does not gain weekend eligibility from night overtime', () => {
    premiums(earnings('2026-10-16', [shift('D'), overtime('A')]));
});

test('Monday late-night regular shift carries weekend eligibility into day overtime', () => {
    premiums(earnings('2026-10-12', [shift('N'), overtime('D')]), 0, 15.5, 15.5);
});

test('Monday day regular shift does not gain weekend eligibility from late-night overtime', () => {
    premiums(earnings('2026-10-12', [shift('D'), overtime('N')]));
});

test('Saturday and Sunday regular day shifts grant weekend premiums on overtime', () => {
    for (const date of ['2026-10-17', '2026-10-18']) {
        premiums(earnings(date, [shift('D'), overtime('N')]), 0, 0, 15.5);
    }
});

test('overtime without a regular shift grants no differentials, including on weekends', () => {
    for (const date of ['2026-10-13', '2026-10-17']) {
        premiums(earnings(date, [overtime('N')]));
    }
});

test('booked-off regular shift grants no differentials to overtime', () => {
    premiums(earnings('2026-10-17', [shift('A', 'Regular', { isBookedOff: true }), overtime('N')]));
});

test('partial overtime receives the regular shift premium for the entered hours', () => {
    const result = earnings('2026-10-16', [shift('A'), shift('N', 'Partial Overtime', {
        partialOt1_5Hours: 2, partialOt2xHours: 3.5,
    })]);
    premiums(result, 13.25, 0, 13.25);
    assert.equal(result.deferred.ot1_5x.pay, 120);
    assert.equal(result.deferred.ot2x.pay, 280);
});

test('banked overtime still pays eligible premiums while banking base overtime earnings', () => {
    const result = earnings('2026-10-13', [shift('A'), overtime('N', { isBanked: true })], {
        pattern: ['A', 'A', 'N', 'N', 'D', 'D', 'O', 'O', 'O'],
    });
    premiums(result, 15.5);
    assert.equal(result.equivalentBankedOtHours, 14);
    assert.equal(result.deferred.ot1_5x.pay, 0);
    assert.equal(result.deferred.ot2x.pay, 0);
});

test('premium eligibility does not depend on shift order or overtime category', () => {
    premiums(earnings('2026-10-13', [shift('N', 'Second Overtime'), shift('A')]), 15.5);
});

test('default scheduled regular shifts retain their premiums', () => {
    premiums(earnings('2026-10-13', null, { pattern: ['N', ...Array(8).fill('O')] }), 0, 7.75);
});

test('regular shifts retain their existing night, late-night, weekend and booked-off rules', () => {
    const cases = [
        ['2026-10-13', 'D', 0, 0, 0],
        ['2026-10-13', 'A', 7.75, 0, 0],
        ['2026-10-13', 'N', 0, 7.75, 0],
        ['2026-10-16', 'D', 0, 0, 0],
        ['2026-10-16', 'A', 7.75, 0, 7.75],
        ['2026-10-16', 'N', 0, 7.75, 0],
        ['2026-10-12', 'A', 7.75, 0, 0],
        ['2026-10-12', 'N', 0, 7.75, 7.75],
        ['2026-10-17', 'D', 0, 0, 7.75],
        ['2026-10-18', 'N', 0, 7.75, 7.75],
    ];
    for (const [date, type, night, lateNight, weekend] of cases) {
        premiums(earnings(date, [shift(type)]), night, lateNight, weekend);
        premiums(earnings(date, [shift(type, 'Regular', { isBookedOff: true })]));
    }
});

test('base, overtime, escort and stat pay remain intact', () => {
    const result = earnings('2026-10-13', [shift('A'), overtime('N', { hasEscort: true })], {
        pattern: ['A', 'A', 'N', 'N', 'D', 'D', 'O', 'O', 'O'],
    });
    assert.equal(result.regularPay.pay, 3100);
    assert.equal(result.deferred.ot1_5x.pay, 120);
    assert.equal(result.deferred.ot2x.pay, 440);
    assert.equal(result.deferred.stm.pay, 40);

    const holidayResult = earnings('2026-10-13', [shift('A'), overtime('N')], {
        holidays: { '2026-10-13': 'Test holiday' },
    });
    premiums(holidayResult, 15.5);
    assert.equal(holidayResult.deferred.statHolidayBonus.pay, 155);
    assert.equal(holidayResult.deferred.ot1_5x.pay, 465);
});
