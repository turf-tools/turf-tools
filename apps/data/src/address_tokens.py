"""Street address token equivalency groups for fuzzy address matching.

Used by `src.dags.tiger` to expand blockface street_name_tokens so that
abbreviated and full-form street type tokens are treated as equivalent
during voter address matching (e.g. "st" matches "street", "ave" matches "avenue").
"""

# Each inner list is a group of tokens that should be treated as equivalent
# when matching voter address strings against TIGER blockface street names.
EQUIVALENT_TOKEN_GROUPS: list[list[str]] = [
    # Cardinal directions
    ["n", "north"],
    ["s", "south"],
    ["e", "east"],
    ["w", "west"],
    ["ne", "northeast"],
    ["nw", "northwest"],
    ["se", "southeast"],
    ["sw", "southwest"],

    # Street types
    ["st", "street"],
    ["ave", "avenue", "av"],
    ["rd", "road"],
    ["dr", "drive"],
    ["ln", "lane"],
    ["ct", "court"],
    ["pl", "place"],
    ["blvd", "boulevard"],
    ["pkwy", "parkway"],
    ["hwy", "highway"],
    ["cir", "circle"],
    ["ter", "terrace"],
    ["way"],
    ["sq", "square"],
    ["loop"],
    ["run"],
    ["walk"],
    ["trail"],
    ["path"],
    ["alley", "aly"],
    ["crescent", "cres"],
    ["bend"],
    ["grove"],
    ["hill"],
    ["ridge"],
    ["valley"],
    ["park"],
    ["gardens", "gdns"],
    ["heights", "hts"],

    # Building/unit types
    ["apt", "apartment"],
    ["unit"],
    ["ste", "suite"],
    ["fl", "floor"],
    ["bldg", "building"],

    # Ordinal numbers (important for numbered streets like "42nd St")
    ["1st", "first"],
    ["2nd", "second"],
    ["3rd", "third"],
    ["4th", "fourth"],
    ["5th", "fifth"],
    ["6th", "sixth"],
    ["7th", "seventh"],
    ["8th", "eighth"],
    ["9th", "ninth"],
    ["10th", "tenth"],
    ["11th", "eleventh"],
    ["12th", "twelfth"],
    ["13th", "thirteenth"],
    ["14th", "fourteenth"],
    ["15th", "fifteenth"],
    ["16th", "sixteenth"],
    ["17th", "seventeenth"],
    ["18th", "eighteenth"],
    ["19th", "nineteenth"],
    ["20th", "twentieth"],
    ["21st", "twenty-first"],
    ["22nd", "twenty-second"],
    ["23rd", "twenty-third"],
    ["30th", "thirtieth"],
    ["40th", "fortieth"],
    ["50th", "fiftieth"],
    ["60th", "sixtieth"],
    ["70th", "seventieth"],
    ["80th", "eightieth"],
    ["90th", "ninetieth"],
    ["100th", "one-hundredth"],
]
