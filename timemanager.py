from datetime import datetime, timedelta

class UniversalClock:
    def __init__(self):
        self.manual_time = None
        self.is_manual = False

    def set_manual_time(self, hour, minute):
        """Sets the clock to a specific time for testing."""
        now = datetime.now()
        self.manual_time = now.replace(hour=hour, minute=minute, second=0)
        self.is_manual = True

    def get_current_time(self):
        """Returns either the real time or the manual override."""
        if self.is_manual:
            return self.manual_time.strftime("%H:%M:%S")
        return datetime.now().strftime("%H:%M:%S")

# Initialize the clock
clock = UniversalClock()