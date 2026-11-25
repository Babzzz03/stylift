<?php
/**
 * Validation and cleaning of the Elementor element tree the extension sends.
 *
 * The tree is plain data (containers, widgets, settings). Widgets carry captured HTML;
 * captures arrive without scripts, but the server never trusts that: <script> blocks,
 * inline event handlers and javascript: URLs are removed again here.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class StyleLift_Sanitizer {

	const MAX_DEPTH    = 40;
	const MAX_ELEMENTS = 5000;

	/** Element types Elementor knows. */
	const EL_TYPES = array( 'container', 'section', 'column', 'widget' );

	/**
	 * Validate and clean a list of elements. Returns the cleaned list or WP_Error.
	 *
	 * @param mixed $elements Decoded JSON.
	 * @return array|WP_Error
	 */
	public static function clean_elements( $elements ) {
		if ( ! is_array( $elements ) || empty( $elements ) ) {
			return new WP_Error( 'stylelift_empty', 'The import has no sections.', array( 'status' => 400 ) );
		}
		$count = 0;
		$out   = self::clean_list( $elements, 0, $count );
		if ( is_wp_error( $out ) ) {
			return $out;
		}
		return $out;
	}

	private static function clean_list( $list, $depth, &$count ) {
		if ( $depth > self::MAX_DEPTH ) {
			return new WP_Error( 'stylelift_depth', 'The import is nested too deeply.', array( 'status' => 400 ) );
		}
		$out = array();
		foreach ( array_values( $list ) as $el ) {
			if ( ! is_array( $el ) ) {
				continue;
			}
			if ( ++$count > self::MAX_ELEMENTS ) {
				return new WP_Error( 'stylelift_size', 'The import has too many elements.', array( 'status' => 413 ) );
			}
			$type = isset( $el['elType'] ) ? (string) $el['elType'] : '';
			if ( ! in_array( $type, self::EL_TYPES, true ) ) {
				continue;
			}
			$clean = array(
				'id'       => self::clean_id( isset( $el['id'] ) ? $el['id'] : '' ),
				'elType'   => $type,
				'isInner'  => ! empty( $el['isInner'] ),
				'settings' => self::clean_settings( isset( $el['settings'] ) && is_array( $el['settings'] ) ? $el['settings'] : array() ),
				'elements' => array(),
			);
			if ( 'widget' === $type ) {
				$clean['widgetType'] = preg_replace( '/[^a-z0-9_\-]/i', '', isset( $el['widgetType'] ) ? (string) $el['widgetType'] : 'html' );
			}
			if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
				$kids = self::clean_list( $el['elements'], $depth + 1, $count );
				if ( is_wp_error( $kids ) ) {
					return $kids;
				}
				$clean['elements'] = $kids;
			}
			$out[] = $clean;
		}
		return $out;
	}

	private static function clean_id( $id ) {
		$id = preg_replace( '/[^a-z0-9]/i', '', (string) $id );
		if ( '' === $id ) {
			$id = substr( md5( uniqid( '', true ) ), 0, 7 );
		}
		return substr( $id, 0, 12 );
	}

	/** Settings are data; any string value that may hold markup is cleaned. */
	private static function clean_settings( array $settings ) {
		$out = array();
		foreach ( $settings as $key => $value ) {
			$key = preg_replace( '/[^a-z0-9_\-]/i', '', (string) $key );
			if ( '' === $key ) {
				continue;
			}
			if ( is_array( $value ) ) {
				$out[ $key ] = self::clean_settings( $value );
			} elseif ( is_string( $value ) ) {
				$out[ $key ] = self::clean_markup( $value );
			} elseif ( is_bool( $value ) || is_int( $value ) || is_float( $value ) || null === $value ) {
				$out[ $key ] = $value;
			}
		}
		return $out;
	}

	/**
	 * Remove executable parts from captured HTML while keeping layout and styles:
	 * <script>, <noscript> wrappers of scripts, inline on* handlers, javascript: URLs,
	 * <iframe srcdoc>, <object>/<embed>, and <base> (would retarget every link on the page).
	 */
	public static function clean_markup( $html ) {
		if ( false === strpos( $html, '<' ) && false === stripos( $html, 'javascript:' ) ) {
			return $html;
		}
		$html = preg_replace( '#<script\b[^>]*>.*?</script\s*>#is', '', $html );
		$html = preg_replace( '#<script\b[^>]*/?>#i', '', $html );
		$html = preg_replace( '#<(object|embed|applet)\b[^>]*>.*?</\1\s*>#is', '', $html );
		$html = preg_replace( '#<(object|embed|applet|base)\b[^>]*/?>#i', '', $html );
		// on* handlers in any quoting style
		$html = preg_replace( '#\s+on[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)#i', '', $html );
		$html = preg_replace( '#\s+srcdoc\s*=\s*("[^"]*"|\'[^\']*\')#i', '', $html );
		// javascript: / vbscript: URLs in attributes
		$html = preg_replace( '#(\s(?:href|src|action|formaction|xlink:href)\s*=\s*["\']?)\s*(?:javascript|vbscript)\s*:#i', '$1#blocked:', $html );
		return $html;
	}
}
