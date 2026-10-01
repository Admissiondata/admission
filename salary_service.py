from decimal import Decimal, ROUND_HALF_UP


TWOPLACES = Decimal("0.01")


def _money(value, field_name):
    try:
        amount = Decimal(str(value))
    except Exception as exc:
        raise ValueError(f"{field_name} must be a number") from exc
    if amount < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return amount


def _whole_days(value, field_name):
    try:
        days = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a whole number") from exc
    if days < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return days


def calculate_salary(*, monthly_salary, working_days, present_days, paid_leave=0, unpaid_leave=0, special_present_days=0, adjustment=0):
    """Calculate a faculty salary from the selected monthly attendance."""
    monthly_salary = _money(monthly_salary, "Monthly salary")
    adjustment = Decimal(str(adjustment or 0))
    working_days = _whole_days(working_days, "Working days")
    present_days = _whole_days(present_days, "Present days")
    paid_leave = _whole_days(paid_leave, "Paid leave")
    unpaid_leave = _whole_days(unpaid_leave, "Unpaid leave")
    special_present_days = _whole_days(special_present_days, "Special present days")

    if working_days <= 0:
        raise ValueError("Working days must be greater than zero")
    if present_days > working_days:
        raise ValueError("Present days cannot exceed working days")
    if paid_leave > working_days:
        raise ValueError("Paid leave cannot exceed working days")
    if unpaid_leave > working_days:
        raise ValueError("Unpaid leave cannot exceed working days")

    scheduled_paid_days = present_days + paid_leave
    if scheduled_paid_days > working_days:
        raise ValueError("Paid days cannot exceed working days")

    paid_days = scheduled_paid_days + special_present_days
    daily_salary = monthly_salary / Decimal(working_days)
    calculated_salary = daily_salary * Decimal(paid_days)
    final_salary = calculated_salary + adjustment

    return {
        "monthly_salary": monthly_salary.quantize(TWOPLACES, rounding=ROUND_HALF_UP),
        "working_days": working_days,
        "present_days": present_days + special_present_days,
        "regular_present_days": present_days,
        "special_present_days": special_present_days,
        "absent_days": working_days - present_days - paid_leave - unpaid_leave,
        "paid_leave": paid_leave,
        "unpaid_leave": unpaid_leave,
        "paid_days": paid_days,
        "daily_salary": daily_salary.quantize(TWOPLACES, rounding=ROUND_HALF_UP),
        "calculated_salary": calculated_salary.quantize(TWOPLACES, rounding=ROUND_HALF_UP),
        "adjustment": adjustment.quantize(TWOPLACES, rounding=ROUND_HALF_UP),
        "final_salary": final_salary.quantize(TWOPLACES, rounding=ROUND_HALF_UP),
    }
