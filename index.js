import playwright from 'playwright';
import dotenv from 'dotenv';
import holidays from 'holidays-norway';
import express from 'express';
import moment from 'moment';

await dotenv.config();
const paymentDayInMonth = process.env.PAYMENT_DAY_IN_MONTH;
const pricePerMeal = parseFloat(process.env.PRICE_PER_MEAL);

const app = express();
const port = process.env.WEBSERVER_PORT;

app.get('/', async (req, res) => {
    const result = await generateBalanceData();
    if (result) {
        res.json(result);
    } else {
        res.json({
            error: 'Could not obtain account balance'
        });
    }
})

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`)
});

/**
 * Generate balance data.
 *
 * @returns {Promise<{topupNeeded: number, weekdaysUntilNextPayment: number, pricePerMeal: number, balanceCurrencyUnit: *, currentBalance: *, mealsNeeded: number, lastToppedUpUTC: *, currentBalanceInNumberOfMeals: number}|boolean>}
 */
async function generateBalanceData()
{
    const balance = await getK6Balance({
        username: process.env.K6_USERNAME,
        password: process.env.K6_PASSWORD,
    });
    if (balance === false) {
        return false;
    }
    const weekdaysUntilNextPayment = calculateWeekdaysBetweenDates(moment(), getNextPayDate());
    const balanceInNumberOfMeals = Math.floor(balance.currentBalance / pricePerMeal);
    const numberOfMealsNeeded = weekdaysUntilNextPayment - balanceInNumberOfMeals;
    const topupNeeded = numberOfMealsNeeded * pricePerMeal;

    return {
        currentBalance: balance.currentBalance,
        currentBalanceInNumberOfMeals: balanceInNumberOfMeals,
        balanceCurrencyUnit: balance.balanceCurrencyUnit,
        weekdaysUntilNextPayment: weekdaysUntilNextPayment,
        pricePerMeal: pricePerMeal,
        mealsNeeded: numberOfMealsNeeded,
        topupNeeded: topupNeeded,
        lastToppedUpUTC: balance.lastToppedUpUTC,
    };
}

/**
 * Calculate the number of weekdays between two dates.
 *
 * @param from
 * @param to
 * @returns {number}
 */
function calculateWeekdaysBetweenDates(from, to)
{
    let dayCount = 0;
    let daysUntilPayment = to.diff(from, 'days');
    while(daysUntilPayment >= 0) {
        if (![0, 6].includes(to.day())) {
            dayCount++;
        }
        to.subtract(1, 'day');
        daysUntilPayment--;
    }
    return dayCount;
}

/**
 * Get the next pay date while taking norwegian holidays and weekends into consideration.
 *
 * @returns {moment.Moment}
 */
function getNextPayDate()
{
    const nextPayDate = moment().set('date', paymentDayInMonth).set('hour', 0).set('minute', 0).set('second', 0);
    if (nextPayDate.isBefore()) {
        nextPayDate.add(1, 'months');
    }
    const holidayArray = holidays.default(moment().format('Y')).map(holiday => holiday.date);
    while (
        holidayArray.includes(nextPayDate.format('YYYY-MM-DD'))
        || [0, 6].includes(nextPayDate.day())
    ) {
        nextPayDate.subtract(1, 'day');
    }
    return nextPayDate;
}

/**
 * Get the account balance.
 *
 * @param credentials
 * @returns {Promise<{balanceCurrencyUnit: string, currentBalance: number, lastToppedUpUTC: string}|boolean>}
 */
async function getK6Balance(credentials)
{
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({
        headless: true,
    });
    const page = await context.newPage();
    await page.goto(process.env.ACCOUNT_URL);

    await page.waitForSelector('.modal-content input#phone', {
        state: 'visible',
    });
    await page.fill('.modal-content input#phone', credentials.username);
    await page.click('.modal-content button.button-confirm');

    await page.waitForSelector('.modal-content input#password-field', {
        state: 'visible',
    });
    await page.fill('.modal-content input#password-field', credentials.password);
    await page.click('.modal-content button.button-confirm');

    await page.waitForSelector('.balance-and-date', {
        state: 'visible',
    });

    const balanceString = await page.innerText('.balance-and-date .balance');
    const dateString = await page.innerText('.balance-and-date .date');

    const balanceMatcher = new RegExp('^Saldo: ([0-9].+) ([A-Z]{1,5})$', 'i');
    if (!balanceMatcher.test(balanceString)) {
        //console.log('Could not extract balance from markup.');
        return false;
    }
    const balanceMatches = balanceString.match(balanceMatcher);
    const formattedBalance = parseFloat(balanceMatches[1]);
    const currencyUnit = balanceMatches[80];

    const dateMatcher = new RegExp('^([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{4}) ([0-9]{1,2}):([0-9]{1,2})$', 'i');
    if (!dateMatcher.test(dateString)) {
        //console.log('Could not extract date from markup.');
        return false;
    }
    const dateMatches = dateString.match(dateMatcher);
    const dateObject = new Date(parseInt(dateMatches[3]), parseInt(dateMatches[2]) - 1, parseInt(dateMatches[1]), parseInt(dateMatches[4]), parseInt(dateMatches[5]));

    await browser.close();
    return {
        currentBalance: formattedBalance,
        balanceCurrencyUnit: currencyUnit,
        lastToppedUpUTC: dateObject.toISOString(),
    }
}
